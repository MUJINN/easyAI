"""同一后端的自动重试：指数退避 + 抖动（FR-6）。

与 fallback 的分工：retry 在同一后端上按 RetryConfig 重复调用；
重试用尽后由 relay 的外层循环切换到下一个后端。
"""

import asyncio
import random
from typing import Awaitable, Callable

from model_relay.config import RetryConfig
from model_relay.providers.openai_compat import BackendError

T = Awaitable


async def with_retry(
    call: Callable[[], T],
    config: RetryConfig,
    sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep,
    jitter: Callable[[], float] = random.random,
):
    """执行零参 async 闭包，可重试错误按指数退避重试，最后一次错误原样抛出。

    - 退避：min(base_delay * 2**n, max_delay) + [0, base_delay) 抖动；
    - 429 带 Retry-After 时以其建议值为准（仍受 max_delay 封顶）；
    - 非可重试错误（400/401 等）立即抛出。
    """
    last_exc: BackendError | None = None
    for attempt in range(config.max_attempts):
        try:
            return await call()
        except BackendError as exc:
            last_exc = exc
            is_last = attempt == config.max_attempts - 1
            if not exc.retriable or is_last:
                raise
            await sleeper(_delay(exc, attempt, config, jitter))
    # 理论不可达：循环内要么 return 要么 raise
    assert last_exc is not None
    raise last_exc


def _delay(
    exc: BackendError,
    attempt: int,
    config: RetryConfig,
    jitter: Callable[[], float],
) -> float:
    suggested = exc.retry_after()
    if suggested is not None:
        return max(0.0, min(suggested, config.max_delay))
    backoff = config.base_delay * (2**attempt)
    return min(backoff, config.max_delay) + jitter() * config.base_delay
