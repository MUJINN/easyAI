"""汇率服务：免费 exchangerate-api，基准 USD，启动拉取、6h 刷新。

网络不可用时静默保留旧汇率/空汇率；USD 换算永远可用，不依赖本服务。
"""

import time

import httpx

FX_URL = "https://open.er-api.com/v6/latest/USD"
REFRESH_SECONDS = 6 * 3600


class FxService:
    """持有 currency→USD 汇率表（1 USD = rate[currency]）。"""

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client
        self.rates: dict[str, float] = {}
        self.updated_at: float | None = None

    async def update_rates(self) -> bool:
        """拉取最新汇率；成功返回 True，任何失败返回 False（不抛出）。"""
        try:
            resp = await self._get_client().get(FX_URL, timeout=10.0)
            data = resp.json()
        except (httpx.HTTPError, ValueError):
            return False
        if resp.status_code != 200 or data.get("result") != "success":
            return False
        rates = data.get("rates")
        if not isinstance(rates, dict):
            return False
        self.rates = {k: v for k, v in rates.items() if isinstance(v, (int, float))}
        self.updated_at = time.monotonic()
        return True

    def to_usd_x10000(self, amount: float, currency: str) -> int | None:
        """原币金额换算为 USD×10000 整数；币种无汇率返回 None。"""
        code = (currency or "USD").upper()
        if code == "USD":
            return round(amount * 10000)
        rate = self.rates.get(code)
        if not rate:
            return None
        return round((amount / rate) * 10000)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
