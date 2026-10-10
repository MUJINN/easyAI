"""后端驱动注册表：按 BackendConfig.type 分发驱动。

M4 起后端配置存于 DB，本注册表只保留共享 httpx 连接池与驱动分发；
挂载在 app.state，测试可替换为注入 MockTransport 的实例。
"""

import httpx

from model_relay.config import BackendConfig
from model_relay.providers.openai_compat import OpenAICompatProvider


class ProviderRegistry:
    """持有共享连接池，按后端类型分发驱动实例。"""

    def __init__(self, client: httpx.AsyncClient | None = None):
        # 所有驱动共享一个 httpx client（连接池）；测试注入 MockTransport
        self.client = client or httpx.AsyncClient()

    def get_provider(self, backend: BackendConfig):
        """按后端 type 分发驱动；未知类型抛错（配置问题，fail fast）。"""
        if backend.type == "openai":
            return OpenAICompatProvider(client=self.client)
        raise ValueError(f"Unknown backend type: {backend.type}")

    async def aclose(self) -> None:
        await self.client.aclose()
