"""SQLite 数据访问层：连接管理 + 建表。

设计要点（requirements.md 10.2）：
- MVP 用 SQLite 起步，数据访问全部走 repository 抽象，后期换 Postgres 只加实现类。
- 每次操作新建连接（本地 SQLite 开销极小），规避 TestClient 多事件循环下的
  aiosqlite 连接复用问题；开启 WAL 提升并发读写体验。
"""

from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS access_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    key_hash TEXT NOT NULL UNIQUE,
    alias TEXT,
    quota_requests INTEGER,
    quota_amount INTEGER,
    rate_rpm INTEGER,
    max_concurrency INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT
);

CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    api_key_env TEXT,
    timeout REAL NOT NULL DEFAULT 60.0,
    rpm INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_entries (
    id TEXT PRIMARY KEY,
    name TEXT,
    owned_by TEXT NOT NULL DEFAULT 'easyai',
    strategy TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_backends (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    backend_id TEXT NOT NULL,
    backend_model TEXT,
    priority INTEGER NOT NULL DEFAULT 100,
    weight INTEGER NOT NULL DEFAULT 1,
    input_price_per_1k REAL,
    output_price_per_1k REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS requests_log (
    id TEXT PRIMARY KEY,
    access_key_id TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    model TEXT NOT NULL,
    backend_id TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_estimated INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    fallback INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    cost_usd INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_type TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_log_created_at
    ON requests_log (created_at);
CREATE INDEX IF NOT EXISTS idx_requests_log_access_key
    ON requests_log (access_key_id);
CREATE INDEX IF NOT EXISTS idx_model_backends_model
    ON model_backends (model_id);
"""

# 对旧库的增量列：表已存在时 ALTER 补列（SQLite 加列只能用默认值）
_ADDED_COLUMNS = {
    "requests_log": [
        ("fallback", "INTEGER NOT NULL DEFAULT 0"),
        ("attempts", "INTEGER NOT NULL DEFAULT 1"),
        ("cost_usd", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "access_keys": [
        ("rate_rpm", "INTEGER"),
        ("max_concurrency", "INTEGER"),
    ],
}


@asynccontextmanager
async def get_connection(db_path: str):
    """获取 SQLite 连接（每次操作新建，用完即关）。"""
    conn = await aiosqlite.connect(db_path)
    try:
        await conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = aiosqlite.Row
        yield conn
    finally:
        await conn.close()


async def init_db(db_path: str) -> None:
    """建表（幂等）。数据库文件目录不存在时自动创建。

    对旧版本库自动 ALTER 补列。
    """
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    async with get_connection(db_path) as conn:
        await conn.executescript(SCHEMA)
        for table, columns in _ADDED_COLUMNS.items():
            cursor = await conn.execute(f"PRAGMA table_info({table})")
            existing = {row[1] for row in await cursor.fetchall()}
            for name, decl in columns:
                if name not in existing:
                    await conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN {name} {decl}"
                    )
        await conn.commit()
