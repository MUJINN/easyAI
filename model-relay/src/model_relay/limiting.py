"""限流（令牌桶）与并发上限（FR-6）。

三级速率限制：
- global：全局配置 limits.global_rpm
- per-key：access_keys.rate_rpm
- per-backend：providers.rpm

进程内、内存实现：与单实例/单容器目标一致；水平扩展时换 Redis 实现
（接口保持 check/try 两个动作）。并发用 asyncio 信号量排队。
"""

import asyncio
import time
from dataclasses import dataclass

from model_relay.config import BackendConfig, LimitsConfig
from model_relay.db.repos import KeyRecord
from model_relay.errors import openai_error


class TokenBucket:
    """经典令牌桶：容量=rpm，按秒匀速补充。"""

    def __init__(self, rpm: int):
        self.capacity = rpm
        self.tokens = float(rpm)
        self.rate = rpm / 60.0
        self.updated = time.monotonic()

    def allow(self) -> bool:
        self._refill()
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False

    def retry_after(self) -> int:
        """预计还需等待的整秒数（至少 1s）。"""
        self._refill()
        return max(1, int((1.0 - self.tokens) / self.rate) + 1)

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self.updated
        if elapsed > 0:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.updated = now


@dataclass
class _Slots:
    """一次请求持有的并发席位（释放时直接使用持有的信号量引用）。"""

    global_sem: asyncio.Semaphore | None
    key_sem: asyncio.Semaphore | None


class Governance:
    """速率桶 + 并发信号量的进程内注册表，挂载在 app.state。"""

    def __init__(self):
        self._buckets: dict[str, TokenBucket] = {}
        # name -> (配置的并发上限, 信号量)
        self._semaphores: dict[str, tuple[int, asyncio.Semaphore]] = {}

    def check_request(self, key: KeyRecord, limits: LimitsConfig) -> None:
        """全局 + per-key 速率检查；超限抛 OpenAI 格式 429。"""
        if limits.global_rpm:
            self._raise_if_rejected("global", limits.global_rpm)
        if key.rate_rpm:
            self._raise_if_rejected(f"key:{key.id}", key.rate_rpm)

    def try_backend(self, backend: BackendConfig) -> bool:
        """per-backend 令牌；取不到返回 False（调用方改投下一个后端）。"""
        if not backend.rpm:
            return True
        return self._bucket(f"backend:{backend.id}", backend.rpm).allow()

    async def acquire_slots(
        self, key: KeyRecord, limits: LimitsConfig
    ) -> _Slots:
        """获取全局与 per-key 并发席位（排队等待）。"""
        if limits.global_concurrency:
            global_sem = self._semaphore("__global__", limits.global_concurrency)
            await global_sem.acquire()
        else:
            global_sem = None

        key_sem = None
        if key.max_concurrency:
            key_sem = self._semaphore(f"key:{key.id}", key.max_concurrency)
            try:
                await key_sem.acquire()
            except BaseException:
                if global_sem is not None:
                    global_sem.release()
                raise

        return _Slots(global_sem, key_sem)

    def release_slots(self, slots: _Slots) -> None:
        # 逆序释放：先 key 后 global
        if slots.key_sem is not None:
            slots.key_sem.release()
        if slots.global_sem is not None:
            slots.global_sem.release()

    def reset(self) -> None:
        """清空全部状态（测试用）。"""
        self._buckets.clear()
        self._semaphores.clear()

    def _raise_if_rejected(self, name: str, rpm: int) -> None:
        bucket = self._bucket(name, rpm)
        if not bucket.allow():
            retry_after = str(bucket.retry_after())
            raise openai_error(
                429,
                f"Rate limit reached for {name}. "
                f"Please retry after {retry_after}s.",
                error_type="rate_limit_error",
                code="rate_limit_exceeded",
                headers={"Retry-After": retry_after},
            )

    def _bucket(self, name: str, rpm: int) -> TokenBucket:
        # 配额被管理面调整后重建桶
        bucket = self._buckets.get(name)
        if bucket is None or bucket.capacity != rpm:
            bucket = TokenBucket(rpm)
            self._buckets[name] = bucket
        return bucket

    def _semaphore(self, name: str, concurrency: int) -> asyncio.Semaphore:
        entry = self._semaphores.get(name)
        if entry is None or entry[0] != concurrency:
            # 配置变更后重建（排队中的请求留在旧信号量上，释放时互不影响）
            entry = (concurrency, asyncio.Semaphore(concurrency))
            self._semaphores[name] = entry
        return entry[1]
