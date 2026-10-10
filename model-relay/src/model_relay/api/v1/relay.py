"""OpenAI 兼容的转发端点。

请求主链路：
鉴权 → 全局/per-key 限流 → 目录解析 → 额度预检 → 获取并发席位
     → per-backend 限流 / 金额可核算性筛选 → 同后端重试
     →（可重试错误）fallback → 费用估算 / 记账 → 释放席位
"""

import json
import time
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from model_relay.api.deps import get_settings_dependency
from model_relay.auth import require_api_key
from model_relay.billing.fx import FxService
from model_relay.billing.pricing import estimate_cost_x10000, is_priceable
from model_relay.billing.quota import ensure_quota_available
from model_relay.config import BackendConfig, Settings
from model_relay.db.catalog_repos import (
    SqliteModelEntryRepo,
    SqliteProviderRepo,
)
from model_relay.db.repos import (
    KeyRecord,
    RequestLogRecord,
    SqliteRequestLogRepo,
)
from model_relay.errors import OpenAIHTTPException, openai_error
from model_relay.limiting import Governance
from model_relay.providers import ProviderRegistry
from model_relay.providers.openai_compat import BackendError
from model_relay.retrying import with_retry
from model_relay.routing import active_bindings, select_order, select_strategy
from model_relay.schemas import ChatCompletionRequest, ModelObject

router = APIRouter(tags=["relay"])


def _model_not_found(model: str) -> OpenAIHTTPException:
    """OpenAI 兼容的 404 错误。"""
    return openai_error(
        404,
        f"The model '{model}' does not exist.",
        code="model_not_found",
    )


def _backend_http_error(exc: BackendError) -> OpenAIHTTPException:
    """把上游错误体转为 OpenAI 格式异常（错误体本就是 OpenAI 结构）。"""
    error = exc.body.get("error") if isinstance(exc.body, dict) else None
    if not isinstance(error, dict):
        error = {"message": "Upstream error.", "type": "upstream_error"}
    return OpenAIHTTPException(exc.status_code, error)


def _exhausted(
    last_error: BackendError | None, reasons: list[str]
) -> OpenAIHTTPException:
    """所有候选均未成功时的最终错误。"""
    if last_error is not None:
        return _backend_http_error(last_error)
    if reasons and all(r == "price" for r in reasons):
        return openai_error(
            503,
            "No priceable backend available: pricing or FX rates missing. "
            "Configure prices (or fetch FX) and retry.",
            error_type="api_error",
            code="pricing_unavailable",
        )
    return openai_error(
        429,
        "All backends are rate-limited. Please retry later.",
        error_type="rate_limit_error",
        code="rate_limit_exceeded",
    )


@router.get("/models")
async def list_models(settings: Settings = Depends(get_settings_dependency)) -> dict:
    """列出当前至少有一个可用后端的统一模型目录。"""
    backends = await _backend_map(settings)
    entries = await SqliteModelEntryRepo(settings.db_path).list()
    now = int(time.time())
    data = [
        ModelObject(id=entry.id, created=now, owned_by=entry.owned_by)
        for entry in entries
        if active_bindings(entry, backends)
    ]
    return {
        "object": "list",
        "data": [m.model_dump(mode="json") for m in data],
    }


@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    app_request: Request,
    key: KeyRecord = Depends(require_api_key),
    settings: Settings = Depends(get_settings_dependency),
):
    """兼容 OpenAI 的 chat completions：限流/额度/重试/fallback 全链路。"""
    started = time.perf_counter()
    routing = settings.load_yaml_config().routing
    governance: Governance = app_request.app.state.governance

    # 1. 全局 / per-key 速率限制
    governance.check_request(key, routing.limits)

    # 2. 目录解析（DB）
    entry = await SqliteModelEntryRepo(settings.db_path).get(body.model)
    if entry is None:
        raise _model_not_found(body.model)
    backends = await _backend_map(settings)
    bindings = active_bindings(entry, backends)
    if not bindings:
        raise _model_not_found(body.model)

    # 3. 额度预检（次数 / 金额）
    await ensure_quota_available(settings.db_path, key)

    # 4. 路由顺序
    strategy = select_strategy(entry, routing.strategy)
    order = select_order(entry, bindings, strategy)

    # 5. 并发席位（流式持有到流结束）
    slots = await governance.acquire_slots(key, routing.limits)

    registry: ProviderRegistry = app_request.app.state.providers
    fx: FxService = app_request.app.state.fx
    try:
        if body.stream:
            return await _stream_with_fallback(
                registry, entry, order, backends, body, settings, key,
                routing.retry, governance, fx, slots, started,
            )
        return await _chat_with_fallback(
            registry, entry, order, backends, body, settings, key,
            routing.retry, governance, fx, slots, started,
        )
    except BaseException:
        # 成功路径在各 wrapper / _emit 内释放；这里兜底建立响应前的失败
        governance.release_slots(slots)
        raise


async def _backend_map(settings: Settings) -> dict[str, BackendConfig]:
    providers = await SqliteProviderRepo(settings.db_path).list()
    return {b.id: b for b in providers}


async def _chat_with_fallback(
    registry: ProviderRegistry,
    entry,
    order: list,
    backends: dict[str, BackendConfig],
    body: ChatCompletionRequest,
    settings: Settings,
    key: KeyRecord,
    retry_config,
    governance: Governance,
    fx: FxService,
    slots,
    started: float,
):
    """非流式：筛选 → 重试 → fallback。"""
    last_error: BackendError | None = None
    reasons: list[str] = []
    called = 0

    for index, binding in enumerate(order):
        called += 1  # 路由层候选（含限流/不可计价跳过）都计入 fallback 尝试
        backend = backends[binding.backend]
        if not governance.try_backend(backend):
            reasons.append("rate")
            continue
        if key.quota_amount is not None and not is_priceable(binding, fx):
            reasons.append("price")
            continue

        provider = registry.get_provider(backend)
        backend_model = binding.backend_model or entry.id
        try:
            data = await with_retry(
                lambda: provider.chat_completion(backend, body, backend_model),
                retry_config,
            )
        except BackendError as exc:
            last_error = exc
            if exc.retriable and index < len(order) - 1:
                continue
            await _log_request(
                settings, key, entry.id, binding.backend, 0, 0, False,
                "error", f"backend_{exc.status_code}", called, 0, started,
            )
            # 席位由外层 chat_completions 的 except 兜底释放
            raise _backend_http_error(exc) from exc

        usage = data.get("usage") or {}
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        cost = estimate_cost_x10000(
            binding, prompt_tokens, completion_tokens, fx
        )
        await _log_request(
            settings, key, entry.id, binding.backend,
            prompt_tokens, completion_tokens, False,
            "success", None, called, cost or 0, started,
        )
        governance.release_slots(slots)
        return data

    raise _exhausted(last_error, reasons)


async def _stream_with_fallback(
    registry: ProviderRegistry,
    entry,
    order: list,
    backends: dict[str, BackendConfig],
    body: ChatCompletionRequest,
    settings: Settings,
    key: KeyRecord,
    retry_config,
    governance: Governance,
    fx: FxService,
    slots,
    started: float,
):
    """流式：首帧到达前可重试/可 fallback；首帧取得后绑定该后端。"""
    last_error: BackendError | None = None
    reasons: list[str] = []
    called = 0

    for index, binding in enumerate(order):
        called += 1  # 路由层候选（含限流/不可计价跳过）都计入 fallback 尝试
        backend = backends[binding.backend]
        if not governance.try_backend(backend):
            reasons.append("rate")
            continue
        if key.quota_amount is not None and not is_priceable(binding, fx):
            reasons.append("price")
            continue

        provider = registry.get_provider(backend)
        backend_model = binding.backend_model or entry.id

        async def _open() -> tuple:
            gen = provider.chat_completion_stream(backend, body, backend_model)
            first = await anext(gen)
            return gen, first

        empty = False
        try:
            gen, first = await with_retry(_open, retry_config)
        except StopAsyncIteration:
            empty = True
            gen, first = None, None
        except BackendError as exc:
            last_error = exc
            if exc.retriable and index < len(order) - 1:
                continue
            await _log_request(
                settings, key, entry.id, binding.backend, 0, 0, False,
                "error", f"backend_{exc.status_code}", called, 0, started,
            )
            # 席位由外层 chat_completions 的 except 兜底释放
            raise _backend_http_error(exc) from exc

        stream: AsyncIterator = gen if gen is not None else _empty_stream()
        return StreamingResponse(
            _emit(
                None if empty else first, stream, settings, key, entry.id,
                binding, started, called, fx, governance, slots,
            ),
            media_type="text/event-stream",
        )

    raise _exhausted(last_error, reasons)


async def _empty_stream():
    """空异步迭代器（上游首帧即结束的占位）。"""
    if False:
        yield  # pragma: no cover


async def _emit(
    first: dict | None,
    stream: AsyncIterator,
    settings: Settings,
    key: KeyRecord,
    model: str,
    binding,
    started: float,
    called: int,
    fx: FxService,
    governance: Governance,
    slots,
):
    """SSE 生成器：逐帧透传，流结束后估算费用、记账并释放并发席位。

    流中途失败无法 fallback（部分内容已发给客户端），以 error 帧收尾。
    """
    prompt_tokens = 0
    completion_tokens = 0
    completion_chars = 0
    status = "success"
    error_type = None
    got_usage_frame = False

    try:
        if first is None:
            yield "data: [DONE]\n\n"
        else:
            completion_chars += _count_delta_chars(first)
            usage = first.get("usage")
            if usage:
                got_usage_frame = True
                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
            yield f"data: {json.dumps(first)}\n\n"

        async for chunk in stream:
            if chunk is None:
                yield "data: [DONE]\n\n"
                continue
            completion_chars += _count_delta_chars(chunk)
            usage = chunk.get("usage")
            if usage:
                got_usage_frame = True
                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
            yield f"data: {json.dumps(chunk)}\n\n"
    except BackendError as exc:
        status = "error"
        error_type = f"backend_{exc.status_code}"
        yield f"data: {json.dumps(exc.body)}\n\n"
    finally:
        estimated = not got_usage_frame
        if estimated:
            # 上游无 usage 帧（如 Ollama）：输入无法回放按 0 记，输出按字符粗估
            prompt_tokens = 0
            completion_tokens = completion_chars // 4
        cost = estimate_cost_x10000(
            binding, prompt_tokens, completion_tokens, fx
        )
        await _log_request(
            settings, key, model, binding.backend,
            prompt_tokens, completion_tokens, estimated,
            status, error_type, called, cost or 0, started,
        )
        governance.release_slots(slots)


def _count_delta_chars(chunk: dict) -> int:
    """统计 chunk 中 delta content 的字符数（用于无 usage 帧时的粗估）。"""
    total = 0
    for choice in chunk.get("choices", []) or []:
        content = (choice.get("delta") or {}).get("content")
        if isinstance(content, str):
            total += len(content)
    return total


async def _log_request(
    settings: Settings,
    key: KeyRecord,
    model: str,
    backend_id: str,
    prompt_tokens: int,
    completion_tokens: int,
    tokens_estimated: bool,
    status: str,
    error_type: str | None,
    attempts: int,
    cost_usd: int,
    started: float,
) -> None:
    """写请求明细；记账失败绝不影响响应。"""
    try:
        await SqliteRequestLogRepo(settings.db_path).add(
            RequestLogRecord(
                id=uuid.uuid4().hex,
                access_key_id=key.id,
                tenant_id=key.tenant_id,
                model=model,
                backend_id=backend_id,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                tokens_estimated=tokens_estimated,
                duration_ms=int((time.perf_counter() - started) * 1000),
                fallback=attempts > 1,
                attempts=attempts,
                cost_usd=cost_usd,
                status=status,
                error_type=error_type,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        )
    except Exception:
        # 记账是尽力而为：失败只记录日志，不向上抛
        pass
