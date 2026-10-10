"""上游后端驱动。

M2 只实现 OpenAI 兼容协议驱动（OpenAI / DeepSeek / Ollama 三家通用），
其他协议（Anthropic / Gemini 原生等）按 type 在后续里程碑扩展。
"""

import json

import httpx

from model_relay.config import BackendConfig


class BackendError(Exception):
    """上游调用失败：携带状态码与（OpenAI 格式的）错误体，供路由层透传。"""

    # 适合 fallback 到下一个后端的状态码：
    # 上游限流 / 服务端故障 / 请求超时（网络故障统一合成为 502）
    RETRIABLE_STATUSES = {408, 429, 500, 502, 503, 504}

    def __init__(
        self,
        status_code: int,
        body: dict,
        headers: httpx.Headers | dict | None = None,
    ):
        super().__init__(f"backend error {status_code}")
        self.status_code = status_code
        self.body = body
        self.headers = headers or {}

    @property
    def retriable(self) -> bool:
        """该错误是否适合重试 / fallback 到备用后端。"""
        return self.status_code in self.RETRIABLE_STATUSES

    def retry_after(self) -> float | None:
        """上游建议的等待秒数（仅识别数字形式的 Retry-After）。"""
        value = self.headers.get("Retry-After") if self.headers else None
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None


class OpenAICompatProvider:
    """OpenAI 兼容协议驱动：把统一请求原样转发到后端。"""

    type = "openai"

    def __init__(self, client: httpx.AsyncClient | None = None):
        # 测试可注入 MockTransport 构造的 client；生产由 registry 共享连接池
        self._client = client

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self._client

    def _build_payload(self, request, backend_model: str) -> dict:
        """剔除 None 字段后原样透传，模型名替换为后端原生名。"""
        payload = request.model_dump(exclude_none=True)
        payload["model"] = backend_model
        return payload

    def _headers(self, backend: BackendConfig) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        api_key = backend.resolve_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def _url(self, backend: BackendConfig) -> str:
        base = (backend.base_url or "").rstrip("/")
        return f"{base}/chat/completions"

    def _timeout(self, backend: BackendConfig, stream: bool) -> httpx.Timeout:
        # 流式生成间隔不可预期，读超时放开；连接/写超时保留
        read = None if stream else backend.timeout
        return httpx.Timeout(connect=10.0, read=read, write=30.0, pool=10.0)

    async def chat_completion(
        self, backend: BackendConfig, request, backend_model: str
    ) -> dict:
        """非流式转发，返回上游解析后的 JSON。"""
        try:
            resp = await self._get_client().post(
                self._url(backend),
                headers=self._headers(backend),
                json=self._build_payload(request, backend_model),
                timeout=self._timeout(backend, stream=False),
            )
        except httpx.HTTPError as exc:
            raise BackendError(
                502,
                {
                    "error": {
                        "message": f"Upstream connection failed: {exc.__class__.__name__}",
                        "type": "upstream_error",
                    }
                },
            ) from exc
        return self._parse_response(resp)

    async def chat_completion_stream(
        self, backend: BackendConfig, request, backend_model: str
    ):
        """流式转发：逐 chunk yield 解析后的 dict，[DONE] 帧以 None 表示。"""
        payload = self._build_payload(request, backend_model)
        # 请求上游在流末尾附带 usage 帧，用于精确记账
        payload["stream"] = True
        payload["stream_options"] = {"include_usage": True}

        try:
            async with self._get_client().stream(
                "POST",
                self._url(backend),
                headers=self._headers(backend),
                json=payload,
                timeout=self._timeout(backend, stream=True),
            ) as resp:
                if resp.status_code != 200:
                    text = (await resp.aread()).decode("utf-8", errors="replace")
                    try:
                        body = json.loads(text)
                    except json.JSONDecodeError:
                        body = {
                            "error": {
                                "message": text[:500],
                                "type": "upstream_error",
                            }
                        }
                    raise BackendError(
                        resp.status_code, body, resp.headers
                    )
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        yield None
                        continue
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        # 无法解析的帧直接跳过，不中断流
                        continue
        except httpx.HTTPError as exc:
            raise BackendError(
                502,
                {
                    "error": {
                        "message": f"Upstream connection failed: {exc.__class__.__name__}",
                        "type": "upstream_error",
                    }
                },
            ) from exc

    @staticmethod
    def _parse_response(resp: httpx.Response) -> dict:
        """非 2xx 透传上游错误体（本就是 OpenAI 格式）；2xx 解析 JSON。"""
        if resp.status_code != 200:
            try:
                body = resp.json()
            except json.JSONDecodeError:
                body = {
                    "error": {
                        "message": resp.text[:500],
                        "type": "upstream_error",
                    }
                }
            raise BackendError(resp.status_code, body, resp.headers)
        return resp.json()
