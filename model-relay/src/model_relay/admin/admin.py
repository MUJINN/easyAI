"""管理 API：健康检查、元数据与 Access Key 管理。

管理面整体使用 Admin Key（MODEL_RELAY_ADMIN_KEY）鉴权。
"""

import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from model_relay.api.deps import get_settings_dependency
from model_relay.auth import hash_key, require_admin_key
from model_relay.config import Settings
from model_relay.db.repos import KeyRecord, SqliteAccessKeyRepo

router = APIRouter(tags=["admin"])


class KeyCreateRequest(BaseModel):
    """创建 Access Key 的请求体（配额/限流 M4 强制生效）。"""

    alias: str | None = None
    quota_requests: int | None = Field(default=None, ge=1)
    # 金额配额：USD × 10000（0.0001 美元精度，见 requirements.md 10.3）
    quota_amount: int | None = Field(default=None, ge=0)
    # per-Key 速率（请求/分钟）与并发上限
    rate_rpm: int | None = Field(default=None, ge=1)
    max_concurrency: int | None = Field(default=None, ge=1)
    expires_at: str | None = None


class KeyUpdateRequest(BaseModel):
    """部分更新；None 字段被跳过。"""

    alias: str | None = None
    quota_requests: int | None = Field(default=None, ge=1)
    quota_amount: int | None = Field(default=None, ge=0)
    rate_rpm: int | None = Field(default=None, ge=1)
    max_concurrency: int | None = Field(default=None, ge=1)
    expires_at: str | None = None
    status: str | None = None


class KeyInfo(BaseModel):
    """Access Key 元数据（不含 hash）。"""

    id: str
    tenant_id: str
    alias: str | None
    quota_requests: int | None
    quota_amount: int | None
    rate_rpm: int | None
    max_concurrency: int | None
    status: str
    created_at: str
    expires_at: str | None


class KeyCreateResponse(KeyInfo):
    """创建成功响应：明文 Key 仅此一次返回。"""

    key: str


def _to_info(record: KeyRecord) -> KeyInfo:
    return KeyInfo(
        id=record.id,
        tenant_id=record.tenant_id,
        alias=record.alias,
        quota_requests=record.quota_requests,
        quota_amount=record.quota_amount,
        rate_rpm=record.rate_rpm,
        max_concurrency=record.max_concurrency,
        status=record.status,
        created_at=record.created_at,
        expires_at=record.expires_at,
    )


@router.get("/health")
async def admin_health() -> dict[str, str]:
    """管理面健康检查。"""
    return {"status": "ok", "admin": "true"}


@router.get("/info")
async def admin_info(settings: Settings = Depends(get_settings_dependency)) -> dict:
    """返回应用元数据与配置概览。"""
    config = settings.load_yaml_config()
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "config_path": settings.config_path,
        "models_exposed": len(config.models),
        "backends_configured": len(config.backends),
    }


@router.post("/keys", response_model=KeyCreateResponse)
async def create_key(
    body: KeyCreateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> KeyCreateResponse:
    """创建 Access Key：返回明文（仅此一次），库中只存 sha256 摘要。"""
    plain_key = f"sk-easyai-{secrets.token_urlsafe(32)}"
    record = KeyRecord(
        id=uuid.uuid4().hex,
        tenant_id="default",
        key_hash=hash_key(plain_key),
        alias=body.alias,
        quota_requests=body.quota_requests,
        quota_amount=body.quota_amount,
        rate_rpm=body.rate_rpm,
        max_concurrency=body.max_concurrency,
        status="active",
        created_at=datetime.now(timezone.utc).isoformat(),
        expires_at=body.expires_at,
    )
    await SqliteAccessKeyRepo(settings.db_path).create(record)
    return KeyCreateResponse(key=plain_key, **_to_info(record).model_dump())


@router.get("/keys", response_model=list[KeyInfo])
async def list_keys(
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> list[KeyInfo]:
    """列出全部 Access Key（不含 hash）。"""
    records = await SqliteAccessKeyRepo(settings.db_path).list()
    return [_to_info(r) for r in records]


@router.delete("/keys/{key_id}")
async def revoke_key(
    key_id: str,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> dict:
    """吊销 Access Key（软删除：status 置为 revoked）。"""
    revoked = await SqliteAccessKeyRepo(settings.db_path).revoke(key_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="Key not found.")
    return {"id": key_id, "status": "revoked"}


@router.patch("/keys/{key_id}", response_model=KeyInfo)
async def update_key(
    key_id: str,
    body: KeyUpdateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> KeyInfo:
    """部分更新 Key：配额 / 限流 / 过期时间 / 状态（可重新启用）。"""
    repo = SqliteAccessKeyRepo(settings.db_path)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not await repo.update(key_id, fields):
        raise HTTPException(status_code=404, detail="Key not found.")
    found = await repo.get_by_id(key_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Key not found.")
    return _to_info(found)
