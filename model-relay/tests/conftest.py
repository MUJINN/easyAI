"""测试夹具：临时 SQLite + 临时配置（种子导入 DB）+ Mock 上游 + 测试 Key。"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from model_relay.billing.fx import FxService
from model_relay.config import get_settings
from model_relay.main import create_app
from model_relay.providers import ProviderRegistry
from model_relay.routing import reset_round_robin

ADMIN_KEY = "sk-admin-test"

CONFIG_YAML = """\
routing:
  strategy: priority
  retry:
    max_attempts: 3
    base_delay: 0.01
    max_delay: 0.05
models:
  - id: mock-model
    name: Mock Model
    backend: mock-backend
  - id: fallback-model
    backends:
      - backend: backend-a
        priority: 10
        input_price_per_1k: 0.1
        output_price_per_1k: 0.1
      - backend: backend-b
        priority: 20
        input_price_per_1k: 0.1
        output_price_per_1k: 0.1
  - id: rr-model
    strategy: round_robin
    backends:
      - backend: backend-a
      - backend: backend-b
  - id: disabled-model
    backends:
      - backend: backend-a
        enabled: false
      - backend: backend-b
        enabled: false
  - id: dead-backend-model
    backends:
      - backend: disabled-backend
backends:
  - id: mock-backend
    type: openai
    base_url: https://mock-upstream/v1
    api_key_env: MOCK_API_KEY
  - id: backend-a
    type: openai
    base_url: https://mock-a/v1
    api_key_env: MOCK_A_KEY
  - id: backend-b
    type: openai
    base_url: https://mock-b/v1
    api_key_env: MOCK_B_KEY
  - id: disabled-backend
    type: openai
    base_url: https://mock-disabled/v1
    enabled: false
"""


def _success_response(model: str, label: str, stream: bool) -> httpx.Response:
    """构造一个成功的 OpenAI 兼容响应（非流式或带 usage 帧的 SSE）。"""
    content = f"Hello from {label}!"
    if not stream:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 123,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "total_tokens": 14,
                },
            },
        )
    body = "".join(
        [
            'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk",'
            f'"created":123,"model":"{model}","choices":[{{"index":0,'
            f'"delta":{{"role":"assistant","content":"{content}"}},'
            '"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk",'
            f'"created":123,"model":"{model}","choices":[],'
            '"usage":{"prompt_tokens":10,"completion_tokens":2,'
            '"total_tokens":12}}\n\n',
            "data: [DONE]\n\n",
        ]
    )
    return httpx.Response(
        200, text=body, headers={"content-type": "text/event-stream"}
    )


def make_upstream_handler():
    """构造 MockTransport 处理器：按 host 模拟多个 OpenAI 兼容上游。

    - mock-upstream：M2 夹具，支持 trigger-upstream-error / no-usage 分支
    - mock-a（key-a）：可按 content 触发 429 / 500 / 400 / 连接错误 /
      retry-once（首次 500 后成功）/ retry-after（429 + Retry-After 头）
    - mock-b（key-b）：恒成功；fail-all 时 503
    - GET /models：供管理面连通性测试
    """

    # 闭包状态：retry-once 的调用次数（每个 fixture 实例独立）
    attempts_by_host: dict[str, int] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        auth = request.headers.get("Authorization")

        if request.method == "GET" and request.url.path.endswith("/models"):
            if host in ("mock-a", "mock-b"):
                assert auth == f"Bearer {('key-a' if host == 'mock-a' else 'key-b')}"
                return httpx.Response(
                    200,
                    json={"object": "list", "data": [{"id": "mock-m"}]},
                )
            return httpx.Response(
                502, json={"error": {"message": "unknown host", "type": "api_error"}}
            )

        if not request.url.path.endswith("/chat/completions"):
            return httpx.Response(
                404,
                json={
                    "error": {"message": "not found", "type": "invalid_request_error"}
                },
            )

        payload = json.loads(request.content or b"{}")
        model = payload["model"]
        content = payload["messages"][0]["content"]
        stream = bool(payload.get("stream"))

        if host == "mock-upstream":
            assert auth == "Bearer test-upstream-key"

            if content == "trigger-upstream-error":
                return httpx.Response(
                    401,
                    json={
                        "error": {
                            "message": "upstream says no",
                            "type": "authentication_error",
                        }
                    },
                )

            if stream:
                body = (
                    'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk",'
                    f'"created":123,"model":"{model}","choices":[{{"index":0,'
                    '"delta":{"role":"assistant","content":"Hel"},'
                    '"finish_reason":null}]}\n\n'
                    'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk",'
                    f'"created":123,"model":"{model}","choices":[{{"index":0,'
                    '"delta":{"content":"lo"},"finish_reason":null}]}\n\n'
                )
                if content != "no-usage":
                    body += (
                        'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk",'
                        f'"created":123,"model":"{model}","choices":[],'
                        '"usage":{"prompt_tokens":10,"completion_tokens":2,'
                        '"total_tokens":12}}\n\n'
                    )
                body += "data: [DONE]\n\n"
                return httpx.Response(
                    200,
                    text=body,
                    headers={"content-type": "text/event-stream"},
                )
            return _success_response(model, "mock", stream)

        if host == "mock-a":
            assert auth == "Bearer key-a"
            if content == "retry-once":
                attempts_by_host["mock-a"] = attempts_by_host.get("mock-a", 0) + 1
                if attempts_by_host["mock-a"] == 1:
                    return httpx.Response(
                        500,
                        json={
                            "error": {
                                "message": "A first attempt fails",
                                "type": "server_error",
                            }
                        },
                    )
                return _success_response(model, "A", stream)
            if content == "retry-after":
                return httpx.Response(
                    429,
                    headers={"Retry-After": "0.01"},
                    json={
                        "error": {
                            "message": "A is busy",
                            "type": "rate_limit_error",
                        }
                    },
                )
            error_status = {
                "fail-429": 429,
                "fail-500": 500,
                "fail-400": 400,
                "fail-all": 429,
            }.get(content)
            if error_status is not None:
                return httpx.Response(
                    error_status,
                    json={
                        "error": {
                            "message": f"A fails with {error_status}",
                            "type": "upstream_error",
                        }
                    },
                )
            if content == "fail-conn":
                raise httpx.ConnectError("simulated connection failure")
            return _success_response(model, "A", stream)

        if host == "mock-b":
            assert auth == "Bearer key-b"
            if content == "fail-all":
                return httpx.Response(
                    503,
                    json={
                        "error": {
                            "message": "B unavailable",
                            "type": "upstream_error",
                        }
                    },
                )
            return _success_response(model, "B", stream)

        return httpx.Response(
            502, json={"error": {"message": "unknown host", "type": "api_error"}}
        )

    return handler


def _fx_handler(request: httpx.Request) -> httpx.Response:
    """汇率接口 mock：成功响应，含 CNY 汇率。"""
    return httpx.Response(
        200,
        json={
            "result": "success",
            "rates": {"CNY": 7.2, "EUR": 0.9, "USD": 1.0},
        },
    )


def _make_fx() -> FxService:
    """返回走 MockTransport 的汇率服务（测试不触网）。"""
    return FxService(
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(_fx_handler),
            base_url="https://open.er-api.com",
        )
    )


@pytest.fixture
def db_path(tmp_path) -> str:
    """临时 SQLite 数据库路径。"""
    return str(tmp_path / "relay.db")


@pytest.fixture
def client(tmp_path, monkeypatch, db_path):
    """构造带临时状态与 Mock 上游的应用客户端。"""
    config_path = tmp_path / "config.yaml"
    config_path.write_text(CONFIG_YAML, encoding="utf-8")
    monkeypatch.setenv("MODEL_RELAY_DB_PATH", str(db_path))
    monkeypatch.setenv("MODEL_RELAY_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("MODEL_RELAY_ADMIN_KEY", ADMIN_KEY)
    monkeypatch.setenv("MOCK_API_KEY", "test-upstream-key")
    monkeypatch.setenv("MOCK_A_KEY", "key-a")
    monkeypatch.setenv("MOCK_B_KEY", "key-b")
    # lifespan 中创建的 FxService 走 mock，避免真实网络请求
    monkeypatch.setattr("model_relay.main.FxService", _make_fx)
    get_settings.cache_clear()
    # round-robin 计数是进程内全局状态，每个测试从干净起点开始
    reset_round_robin()

    app = create_app()
    with TestClient(app) as test_client:
        # 用注入 MockTransport 的 registry 替换 lifespan 中创建的真实 registry
        transport = httpx.MockTransport(make_upstream_handler())
        mock_client = httpx.AsyncClient(transport=transport)
        app.state.providers = ProviderRegistry(client=mock_client)
        yield test_client

    get_settings.cache_clear()


@pytest.fixture
def api_key(client: TestClient) -> str:
    """通过管理 API 创建测试 Key，返回明文。"""
    resp = client.post(
        "/admin/keys",
        json={"alias": "test"},
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["key"]


@pytest.fixture
def auth_headers(api_key: str) -> dict[str, str]:
    """转发 API 的 Bearer 请求头。"""
    return {"Authorization": f"Bearer {api_key}"}
