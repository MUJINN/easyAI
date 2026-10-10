"""Repository 抽象与 SQLite 实现。

后期换 Postgres 时：新增 postgres/ 实现类，抽象接口保持不变，
调用方零改动（requirements.md 10.2）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from model_relay.db import get_connection


@dataclass
class KeyRecord:
    """access_keys 表记录。"""

    id: str
    tenant_id: str
    key_hash: str
    alias: str | None
    quota_requests: int | None
    quota_amount: int | None
    status: str
    created_at: str
    expires_at: str | None
    # per-Key 速率（请求/分钟）与并发上限；None 不限制
    rate_rpm: int | None = None
    max_concurrency: int | None = None

    @property
    def is_active(self) -> bool:
        return self.status == "active"


@dataclass
class RequestLogRecord:
    """requests_log 表记录。"""

    id: str
    access_key_id: str | None
    tenant_id: str
    model: str
    backend_id: str | None
    prompt_tokens: int
    completion_tokens: int
    tokens_estimated: bool
    duration_ms: int
    status: str
    error_type: str | None
    created_at: str
    # 是否发生了 fallback（尝试了多个后端）
    fallback: bool = False
    # 本次请求尝试的后端数
    attempts: int = 1
    # 估算费用（USD × 10000）；0 表示未核算
    cost_usd: int = 0


class AccessKeyRepo(ABC):
    """Access Key 存储抽象。"""

    @abstractmethod
    async def create(self, record: KeyRecord) -> None: ...

    @abstractmethod
    async def get_by_hash(self, key_hash: str) -> KeyRecord | None: ...

    @abstractmethod
    async def list(self) -> list[KeyRecord]: ...

    @abstractmethod
    async def revoke(self, key_id: str) -> bool: ...


class RequestLogRepo(ABC):
    """请求记账存储抽象。"""

    @abstractmethod
    async def add(self, record: RequestLogRecord) -> None: ...


class SqliteAccessKeyRepo(AccessKeyRepo):
    """AccessKeyRepo 的 SQLite 实现。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def create(self, record: KeyRecord) -> None:
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                """INSERT INTO access_keys
                   (id, tenant_id, key_hash, alias, quota_requests, quota_amount,
                    rate_rpm, max_concurrency, status, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    record.id,
                    record.tenant_id,
                    record.key_hash,
                    record.alias,
                    record.quota_requests,
                    record.quota_amount,
                    record.rate_rpm,
                    record.max_concurrency,
                    record.status,
                    record.created_at,
                    record.expires_at,
                ),
            )
            await conn.commit()

    async def get_by_hash(self, key_hash: str) -> KeyRecord | None:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM access_keys WHERE key_hash = ?", (key_hash,)
            )
            row = await cursor.fetchone()
        return _row_to_key(row)

    async def get_by_id(self, key_id: str) -> KeyRecord | None:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM access_keys WHERE id = ?", (key_id,)
            )
            row = await cursor.fetchone()
        return _row_to_key(row)

    async def list(self) -> list[KeyRecord]:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM access_keys ORDER BY created_at DESC"
            )
            rows = await cursor.fetchall()
        return [_row_to_key(r) for r in rows if r is not None]

    async def revoke(self, key_id: str) -> bool:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "UPDATE access_keys SET status = 'revoked' WHERE id = ?", (key_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def update(self, key_id: str, fields: dict) -> bool:
        """更新配额 / 限流 / 过期 / 状态（仅白名单字段）。"""
        allowed = {
            "alias", "quota_requests", "quota_amount", "rate_rpm",
            "max_concurrency", "expires_at", "status",
        }
        sets, values = [], []
        for key, value in fields.items():
            if key in allowed and value is not ...:
                sets.append(f"{key} = ?")
                values.append(value)
        if not sets:
            return False
        values.append(key_id)
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                f"UPDATE access_keys SET {', '.join(sets)} WHERE id = ?", values
            )
            await conn.commit()
            return cursor.rowcount > 0


class SqliteRequestLogRepo(RequestLogRepo):
    """RequestLogRepo 的 SQLite 实现。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def add(self, record: RequestLogRecord) -> None:
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                """INSERT INTO requests_log
                   (id, access_key_id, tenant_id, model, backend_id,
                    prompt_tokens, completion_tokens, tokens_estimated,
                    duration_ms, fallback, attempts, cost_usd,
                    status, error_type, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    record.id,
                    record.access_key_id,
                    record.tenant_id,
                    record.model,
                    record.backend_id,
                    record.prompt_tokens,
                    record.completion_tokens,
                    int(record.tokens_estimated),
                    record.duration_ms,
                    int(record.fallback),
                    record.attempts,
                    record.cost_usd,
                    record.status,
                    record.error_type,
                    record.created_at,
                ),
            )
            await conn.commit()

    async def get_key_usage(self, access_key_id: str) -> tuple[int, int]:
        """成功请求次数与累计费用（USD×10000），用于额度预检。"""
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                """SELECT COUNT(*) AS cnt,
                          COALESCE(SUM(cost_usd), 0) AS amount
                   FROM requests_log
                   WHERE access_key_id = ? AND status = 'success'""",
                (access_key_id,),
            )
            row = await cursor.fetchone()
        return row["cnt"], row["amount"]

    async def usage_by(
        self,
        group_by: str,
        start: str | None = None,
        end: str | None = None,
    ) -> list[dict]:
        """按维度聚合用量：requests / tokens / cost。

        group_by: key（access_key_id）/ model / backend / day（UTC 日期）。
        """
        dims = {
            "key": "access_key_id",
            "model": "model",
            "backend": "backend_id",
            "day": "substr(created_at, 1, 10)",
        }
        dim = dims.get(group_by, "model")
        where, values = _time_range(start, end)
        sql = f"""
            SELECT {dim} AS dim,
                   COUNT(*) AS requests,
                   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(cost_usd), 0) AS cost_usd
            FROM requests_log {where}
            GROUP BY {dim}
            ORDER BY requests DESC
        """
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(sql, values)
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def query_logs(
        self,
        filters: dict,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """按条件检索请求明细，返回 (行列表, 总数)。"""
        clauses, values = [], []
        for column in ("id", "access_key_id", "model", "backend_id", "status"):
            value = filters.get(column)
            if value:
                clauses.append(f"{column} = ?")
                values.append(value)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                f"SELECT COUNT(*) AS total FROM requests_log {where}", values
            )
            total = (await cursor.fetchone())["total"]
            cursor = await conn.execute(
                f"""SELECT * FROM requests_log {where}
                    ORDER BY created_at DESC, id
                    LIMIT ? OFFSET ?""",
                (*values, limit, offset),
            )
            rows = await cursor.fetchall()
        return [dict(r) for r in rows], total


def _time_range(start: str | None, end: str | None) -> tuple[str, list]:
    """ISO 字符串时间范围过滤（ISO8601 字典序即时间序）。"""
    clauses, values = [], []
    if start:
        clauses.append("created_at >= ?")
        values.append(start)
    if end:
        clauses.append("created_at <= ?")
        values.append(end)
    return (("WHERE " + " AND ".join(clauses)) if clauses else ""), values


def _row_to_key(row: Any | None) -> KeyRecord | None:
    if row is None:
        return None
    return KeyRecord(
        id=row["id"],
        tenant_id=row["tenant_id"],
        key_hash=row["key_hash"],
        alias=row["alias"],
        quota_requests=row["quota_requests"],
        quota_amount=row["quota_amount"],
        status=row["status"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        rate_rpm=row["rate_rpm"],
        max_concurrency=row["max_concurrency"],
    )
