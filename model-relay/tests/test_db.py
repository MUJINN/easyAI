"""数据库层测试：建表幂等 + repository 读写。"""

from model_relay.db import get_connection, init_db
from model_relay.db.repos import (
    KeyRecord,
    RequestLogRecord,
    SqliteAccessKeyRepo,
    SqliteRequestLogRepo,
)


async def test_init_db_idempotent(db_path):
    await init_db(db_path)
    await init_db(db_path)  # 重复执行不抛错


async def test_access_key_repo_roundtrip(db_path):
    await init_db(db_path)
    repo = SqliteAccessKeyRepo(db_path)
    record = KeyRecord(
        id="k1",
        tenant_id="default",
        key_hash="abc123",
        alias="demo",
        quota_requests=100,
        quota_amount=None,
        status="active",
        created_at="2026-01-01T00:00:00+00:00",
        expires_at=None,
    )
    await repo.create(record)

    got = await repo.get_by_hash("abc123")
    assert got is not None
    assert got.id == "k1"
    assert got.alias == "demo"
    assert got.quota_requests == 100
    assert got.is_active

    assert await repo.get_by_hash("missing") is None

    listed = await repo.list()
    assert len(listed) == 1

    assert await repo.revoke("k1") is True
    got = await repo.get_by_hash("abc123")
    assert got.status == "revoked"
    assert not got.is_active

    assert await repo.revoke("missing") is False


async def test_request_log_repo_add(db_path):
    await init_db(db_path)
    repo = SqliteRequestLogRepo(db_path)
    record = RequestLogRecord(
        id="r1",
        access_key_id="k1",
        tenant_id="default",
        model="mock-model",
        backend_id="mock-backend",
        prompt_tokens=10,
        completion_tokens=4,
        tokens_estimated=True,
        duration_ms=42,
        status="success",
        error_type=None,
        created_at="2026-01-01T00:00:00+00:00",
    )
    await repo.add(record)

    async with get_connection(db_path) as conn:
        cursor = await conn.execute(
            "SELECT * FROM requests_log WHERE id = 'r1'"
        )
        row = await cursor.fetchone()
    assert row["prompt_tokens"] == 10
    assert row["completion_tokens"] == 4
    assert row["tokens_estimated"] == 1
    assert row["duration_ms"] == 42
    assert row["status"] == "success"
