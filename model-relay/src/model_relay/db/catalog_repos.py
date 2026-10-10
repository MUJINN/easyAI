"""providers / 模型目录的仓储（SQLite 实现）。

providers.id 与 model_entries.id 即外部可见 id，直接作主键；
model_backends 用内部合成行 id，对外以 (row_id, BackendBinding) 成对返回。
行统一映射为 config 中的 pydantic 模型，provider 驱动层不感知存储。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from model_relay.config import BackendBinding, BackendConfig, ModelEntry
from model_relay.db import get_connection


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SqliteProviderRepo:
    """providers 表仓储。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def create(self, backend: BackendConfig) -> None:
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                """INSERT INTO providers
                   (id, type, base_url, api_key, api_key_env, timeout, rpm,
                    enabled, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    backend.id,
                    backend.type,
                    backend.base_url,
                    backend.api_key,
                    backend.api_key_env,
                    backend.timeout,
                    backend.rpm,
                    int(backend.enabled),
                    _now(),
                    _now(),
                ),
            )
            await conn.commit()

    async def get(self, backend_id: str) -> BackendConfig | None:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM providers WHERE id = ?", (backend_id,)
            )
            row = await cursor.fetchone()
        return _row_to_backend(row)

    async def list(self) -> list[BackendConfig]:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute("SELECT * FROM providers ORDER BY id")
            rows = await cursor.fetchall()
        return [_row_to_backend(r) for r in rows if r is not None]

    async def update(self, backend_id: str, fields: dict) -> bool:
        """按给定字段更新（仅允许白名单字段）。"""
        allowed = {
            "type", "base_url", "api_key", "api_key_env",
            "timeout", "rpm", "enabled",
        }
        sets, values = [], []
        for key, value in fields.items():
            if key not in allowed or value is ...:
                continue
            sets.append(f"{key} = ?")
            values.append(int(value) if key == "enabled" else value)
        if not sets:
            return False
        sets.append("updated_at = ?")
        values.append(_now())
        values.append(backend_id)
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                f"UPDATE providers SET {', '.join(sets)} WHERE id = ?", values
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def delete(self, backend_id: str) -> bool:
        """删除后端并级联清理其绑定。"""
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                "DELETE FROM model_backends WHERE backend_id = ?", (backend_id,)
            )
            cursor = await conn.execute(
                "DELETE FROM providers WHERE id = ?", (backend_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0


class SqliteModelEntryRepo:
    """model_entries + model_backends 表仓储。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def create(self, entry: ModelEntry) -> None:
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                """INSERT INTO model_entries
                   (id, name, owned_by, strategy, enabled, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    entry.id,
                    entry.name,
                    entry.owned_by,
                    entry.strategy,
                    int(entry.enabled),
                    _now(),
                    _now(),
                ),
            )
            for binding in entry.backends:
                await conn.execute(
                    _binding_insert_sql(),
                    _binding_insert_values(uuid.uuid4().hex, entry.id, binding),
                )
            await conn.commit()

    async def get(self, model_id: str) -> ModelEntry | None:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM model_entries WHERE id = ?", (model_id,)
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            bindings = await _fetch_bindings(conn, model_id)
        return _row_to_entry(row, bindings)

    async def list(self) -> list[ModelEntry]:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "SELECT * FROM model_entries ORDER BY id"
            )
            rows = await cursor.fetchall()
            result = []
            for row in rows:
                bindings = await _fetch_bindings(conn, row["id"])
                result.append(_row_to_entry(row, bindings))
        return result

    async def update(self, model_id: str, fields: dict) -> bool:
        allowed = {"name", "owned_by", "strategy", "enabled"}
        sets, values = [], []
        for key, value in fields.items():
            if key not in allowed or value is ...:
                continue
            sets.append(f"{key} = ?")
            values.append(int(value) if key == "enabled" else value)
        if not sets:
            return False
        sets.append("updated_at = ?")
        values.append(_now())
        values.append(model_id)
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                f"UPDATE model_entries SET {', '.join(sets)} WHERE id = ?",
                values,
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def delete(self, model_id: str) -> bool:
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                "DELETE FROM model_backends WHERE model_id = ?", (model_id,)
            )
            cursor = await conn.execute(
                "DELETE FROM model_entries WHERE id = ?", (model_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def list_bindings(
        self, model_id: str
    ) -> list[tuple[str, BackendBinding]]:
        """返回 (内部行 id, 绑定) 列表，管理面改/删绑定需要行 id。"""
        async with get_connection(self.db_path) as conn:
            return await _fetch_bindings(conn, model_id)

    async def add_binding(self, model_id: str, binding: BackendBinding) -> str:
        """新增绑定，返回内部行 id。"""
        row_id = uuid.uuid4().hex
        async with get_connection(self.db_path) as conn:
            await conn.execute(
                _binding_insert_sql(),
                _binding_insert_values(row_id, model_id, binding),
            )
            await conn.execute(
                "UPDATE model_entries SET updated_at = ? WHERE id = ?",
                (_now(), model_id),
            )
            await conn.commit()
        return row_id

    async def update_binding(self, row_id: str, fields: dict) -> bool:
        allowed = {
            "backend_id", "backend_model", "priority", "weight",
            "input_price_per_1k", "output_price_per_1k", "currency", "enabled",
        }
        sets, values = [], []
        for key, value in fields.items():
            if key not in allowed or value is ...:
                continue
            sets.append(f"{key} = ?")
            values.append(int(value) if key == "enabled" else value)
        if not sets:
            return False
        values.append(row_id)
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                f"UPDATE model_backends SET {', '.join(sets)} WHERE id = ?",
                values,
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def delete_binding(self, row_id: str) -> bool:
        async with get_connection(self.db_path) as conn:
            cursor = await conn.execute(
                "DELETE FROM model_backends WHERE id = ?", (row_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0


def _binding_insert_sql() -> str:
    return """INSERT INTO model_backends
        (id, model_id, backend_id, backend_model, priority, weight,
         input_price_per_1k, output_price_per_1k, currency, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""


def _binding_insert_values(
    row_id: str, model_id: str, binding: BackendBinding
) -> tuple:
    return (
        row_id,
        model_id,
        binding.backend,
        binding.backend_model,
        binding.priority,
        binding.weight,
        binding.input_price_per_1k,
        binding.output_price_per_1k,
        binding.currency,
        int(binding.enabled),
    )


async def _fetch_bindings(conn, model_id: str) -> list[tuple[str, BackendBinding]]:
    """按 (priority, rowid) 稳定排序返回 (row_id, binding)。

    同优先级用插入顺序（隐式 rowid）作 tiebreaker，而非随机的业务 id，
    以符合「同序保持配置中的先后」的路由约定。
    """
    cursor = await conn.execute(
        """SELECT * FROM model_backends WHERE model_id = ?
           ORDER BY priority, rowid""",
        (model_id,),
    )
    rows = await cursor.fetchall()
    return [(r["id"], _row_to_binding(r)) for r in rows]


def _row_to_backend(row) -> BackendConfig | None:
    if row is None:
        return None
    return BackendConfig(
        id=row["id"],
        type=row["type"],
        base_url=row["base_url"],
        api_key=row["api_key"],
        api_key_env=row["api_key_env"],
        timeout=row["timeout"],
        rpm=row["rpm"],
        enabled=bool(row["enabled"]),
    )


def _row_to_binding(row) -> BackendBinding:
    return BackendBinding(
        backend=row["backend_id"],
        backend_model=row["backend_model"],
        priority=row["priority"],
        weight=row["weight"],
        input_price_per_1k=row["input_price_per_1k"],
        output_price_per_1k=row["output_price_per_1k"],
        currency=row["currency"],
        enabled=bool(row["enabled"]),
    )


def _row_to_entry(
    row, bindings: list[tuple[str, BackendBinding]]
) -> ModelEntry:
    return ModelEntry(
        id=row["id"],
        name=row["name"],
        owned_by=row["owned_by"],
        strategy=row["strategy"],
        enabled=bool(row["enabled"]),
        backends=[b for _, b in bindings],
    )
