"""并发安全的配额预留（FR-5）。

配额检查与预留在同一 SQLite 写事务中执行；请求结束后账单落库并释放预留。
"""

from model_relay.db.repos import KeyRecord, SqliteRequestLogRepo


async def reserve_quota(
    db_path: str, key: KeyRecord, reservation_id: str
) -> None:
    """Reserve the key's next request and any remaining monetary budget."""
    await SqliteRequestLogRepo(db_path).reserve_quota(key, reservation_id)
