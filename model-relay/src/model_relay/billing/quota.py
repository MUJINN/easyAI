"""额度预检：次数配额与金额配额（FR-5）。

已用量不维护可变计数器，每次按 access key 聚合 requests_log 得到，
避免并发扣减竞态。不足时返回 OpenAI 兼容的 402（insufficient_quota）。
"""

from model_relay.db.repos import KeyRecord, SqliteRequestLogRepo


async def ensure_quota_available(db_path: str, key: KeyRecord) -> tuple[int, int]:
    """请求前检查两类配额，返回当前 (成功次数, 已用金额 USD×10000)。

    - quota_requests：已达上限 → 402；
    - quota_amount：余额 ≤ 0 → 402。
    单次费用超额在请求后发生，只标记不拦截（文档说明）。
    """
    used_requests, used_amount = await SqliteRequestLogRepo(
        db_path
    ).get_key_usage(key.id)

    if key.quota_requests is not None and used_requests >= key.quota_requests:
        _raise_quota_exhausted(
            f"Request quota exhausted ({used_requests}/{key.quota_requests})."
        )
    if key.quota_amount is not None and used_amount >= key.quota_amount:
        _raise_quota_exhausted(
            "Balance exhausted. Please top up or use another key."
        )
    return used_requests, used_amount


def _raise_quota_exhausted(message: str):
    """402 Payment Required，OpenAI 格式。"""
    from model_relay.errors import openai_error

    raise openai_error(
        402,
        message,
        error_type="insufficient_quota",
        code="insufficient_quota",
    )
