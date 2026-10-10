"""管理 API：用量聚合与请求日志检索（FR-5 / FR-7）。"""

from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from model_relay.api.deps import get_settings_dependency
from model_relay.auth import require_admin_key
from model_relay.config import Settings
from model_relay.db.repos import SqliteRequestLogRepo

router = APIRouter(tags=["admin-usage"])

GroupBy = Literal["key", "model", "backend", "day"]


class UsageRow(BaseModel):
    dim: str
    requests: int
    prompt_tokens: int
    completion_tokens: int
    # USD × 10000（0.0001 美元精度），估算仅供参考
    cost_usd: int


class LogItem(BaseModel):
    id: str
    access_key_id: str | None
    tenant_id: str
    model: str
    backend_id: str | None
    prompt_tokens: int
    completion_tokens: int
    tokens_estimated: bool
    duration_ms: int
    fallback: bool
    attempts: int
    cost_usd: int
    status: str
    error_type: str | None
    created_at: str


class LogPage(BaseModel):
    total: int
    items: list[LogItem]


@router.get("/usage", response_model=list[UsageRow])
async def usage(
    group_by: GroupBy = "model",
    start: str | None = Query(default=None, description="ISO 时间起点（含）"),
    end: str | None = Query(default=None, description="ISO 时间终点（含）"),
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> list[UsageRow]:
    """按维度聚合用量（全部状态计入 requests，费用只算成功请求）。"""
    rows = await SqliteRequestLogRepo(settings.db_path).usage_by(
        group_by, start, end
    )
    return [UsageRow(**r) for r in rows]


@router.get("/logs", response_model=LogPage)
async def logs(
    id: str | None = None,
    key_id: str | None = Query(default=None),
    model: str | None = None,
    backend_id: str | None = Query(default=None),
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> LogPage:
    """按条件检索请求明细（时间倒序，分页）。"""
    filters = {
        "id": id,
        "access_key_id": key_id,
        "model": model,
        "backend_id": backend_id,
        "status": status,
    }
    items, total = await SqliteRequestLogRepo(settings.db_path).query_logs(
        filters, limit, offset
    )
    return LogPage(total=total, items=[LogItem(**i) for i in items])
