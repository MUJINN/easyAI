"""转发 API 与管理 API 的 Bearer 鉴权。"""

import hashlib
import hmac
from datetime import datetime, timezone

from fastapi import Depends, Header

from model_relay.api.deps import get_settings_dependency
from model_relay.config import Settings
from model_relay.db.repos import KeyRecord, SqliteAccessKeyRepo
from model_relay.errors import openai_error


def hash_key(plain_key: str) -> str:
    """Key 只以 sha256 摘要入库，不存明文。"""
    return hashlib.sha256(plain_key.encode("utf-8")).hexdigest()


def _auth_error(detail: str):
    """OpenAI 兼容的 401 错误。"""
    return openai_error(
        401,
        detail,
        code="invalid_api_key",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def require_api_key(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings_dependency),
) -> KeyRecord:
    """校验转发 API 的 Bearer Key，返回 access_keys 记录。

    Key 必须存在、active 且未过期（额度扣减 M4 实现）。
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise _auth_error("Missing or malformed Authorization header.")
    plain_key = authorization.removeprefix("Bearer ").strip()
    if not plain_key:
        raise _auth_error("Empty API key.")

    record = await SqliteAccessKeyRepo(settings.db_path).get_by_hash(
        hash_key(plain_key)
    )
    if record is None:
        raise _auth_error("Invalid API key.")
    if not record.is_active:
        raise _auth_error("API key has been revoked.")
    if record.expires_at:
        try:
            # Python 3.10 的 fromisoformat 不支持 "Z" 后缀，先归一化
            expires = datetime.fromisoformat(
                record.expires_at.replace("Z", "+00:00")
            )
            if expires.tzinfo is None:
                # 无时区的过期时间按 UTC 理解
                expires = expires.replace(tzinfo=timezone.utc)
        except ValueError:
            expires = None
        # 无法解析的过期时间按已过期处理（保守拒绝）
        if expires is None or expires <= datetime.now(timezone.utc):
            raise _auth_error("API key has expired.")
    return record


async def require_admin_key(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings_dependency),
) -> None:
    """校验管理 API 的 Admin Key（环境变量 MODEL_RELAY_ADMIN_KEY）。

    未配置 Admin Key 时一律拒绝，避免无人值守的开放管理面。
    """
    if not settings.admin_key:
        raise _auth_error("Admin API is not configured on this instance.")
    if not authorization or not authorization.startswith("Bearer "):
        raise _auth_error("Missing or malformed Authorization header.")
    provided = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(provided, settings.admin_key):
        raise _auth_error("Invalid admin key.")
