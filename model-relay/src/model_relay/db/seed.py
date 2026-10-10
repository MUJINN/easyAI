"""首次启动种子导入：config.yaml → SQLite 目录表。

M4 起运行期配置在 DB。为了让 M2/M3 用户与新用户零迁移成本，
providers 表为空且 YAML 含后端时做一次性导入；导入后 YAML 不再参与运行期。
"""

from model_relay.config import YamlConfig
from model_relay.db.catalog_repos import SqliteModelEntryRepo, SqliteProviderRepo


async def seed_if_empty(db_path: str, config: YamlConfig) -> int:
    """目录为空时导入 YAML，返回导入的后端数；否则返回 0。"""
    if not config.backends:
        return 0

    provider_repo = SqliteProviderRepo(db_path)
    if await provider_repo.list():
        return 0

    for backend in config.backends:
        await provider_repo.create(backend)

    entry_repo = SqliteModelEntryRepo(db_path)
    for entry in config.models:
        await entry_repo.create(entry)

    return len(config.backends)
