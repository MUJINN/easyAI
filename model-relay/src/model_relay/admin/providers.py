"""管理 API：后端（providers）CRUD 与连通性测试。

Key 只回显是否存在（has_api_key），绝不回显明文。
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from model_relay.api.deps import get_settings_dependency
from model_relay.auth import require_admin_key
from model_relay.config import BackendConfig, Settings
from model_relay.db.catalog_repos import SqliteProviderRepo

router = APIRouter(tags=["admin-providers"])


class ProviderCreateRequest(BaseModel):
    """新建后端。api_key 明文仅本地信任环境使用，推荐 api_key_env。"""

    id: str = Field(min_length=1, max_length=64)
    type: str = "openai"
    base_url: str | None = None
    api_key: str | None = None
    api_key_env: str | None = None
    timeout: float = Field(default=60.0, ge=1.0)
    rpm: int | None = Field(default=None, ge=1)
    enabled: bool = True


class ProviderUpdateRequest(BaseModel):
    """部分更新；None 字段会被跳过（区别于显式传值）。"""

    type: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    api_key_env: str | None = None
    timeout: float | None = Field(default=None, ge=1.0)
    rpm: int | None = Field(default=None, ge=1)
    enabled: bool | None = None


class ProviderInfo(BaseModel):
    """对外暴露的后端信息（不含任何 Key 明文）。"""

    id: str
    type: str
    base_url: str | None
    has_api_key: bool
    timeout: float
    rpm: int | None
    enabled: bool


def _to_info(backend: BackendConfig) -> ProviderInfo:
    return ProviderInfo(
        id=backend.id,
        type=backend.type,
        base_url=backend.base_url,
        has_api_key=bool(backend.resolve_api_key() or backend.api_key_env),
        timeout=backend.timeout,
        rpm=backend.rpm,
        enabled=backend.enabled,
    )


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers(
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> list[ProviderInfo]:
    """列出全部后端（不含 Key）。"""
    backends = await SqliteProviderRepo(settings.db_path).list()
    return [_to_info(b) for b in backends]


@router.post("/providers", response_model=ProviderInfo, status_code=201)
async def create_provider(
    body: ProviderCreateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> ProviderInfo:
    """新建后端。"""
    repo = SqliteProviderRepo(settings.db_path)
    if await repo.get(body.id):
        raise HTTPException(status_code=409, detail="Provider id already exists.")
    backend = BackendConfig(**body.model_dump())
    await repo.create(backend)
    return _to_info(backend)


@router.patch("/providers/{provider_id}", response_model=ProviderInfo)
async def update_provider(
    provider_id: str,
    body: ProviderUpdateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> ProviderInfo:
    """部分更新；enabled=false 即动态下架。"""
    repo = SqliteProviderRepo(settings.db_path)
    fields = {
        k: v
        for k, v in body.model_dump().items()
        if v is not None
    }
    updated = await repo.update(provider_id, fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Provider not found.")
    backend = await repo.get(provider_id)
    assert backend is not None
    return _to_info(backend)


@router.delete("/providers/{provider_id}")
async def delete_provider(
    provider_id: str,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> dict:
    """删除后端并级联清理其模型绑定。"""
    deleted = await SqliteProviderRepo(settings.db_path).delete(provider_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Provider not found.")
    return {"id": provider_id, "status": "deleted"}


@router.post("/providers/{provider_id}/test")
async def test_provider(
    provider_id: str,
    app_request: Request,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> dict:
    """连通性测试：带鉴权请求 {base_url}/models。

    不计费、不进日志、不限流；返回检测结果。
    """
    backend = await SqliteProviderRepo(settings.db_path).get(provider_id)
    if backend is None:
        raise HTTPException(status_code=404, detail="Provider not found.")

    client = app_request.app.state.providers.client
    url = (backend.base_url or "").rstrip("/") + "/models"
    headers = {"Content-Type": "application/json"}
    api_key = backend.resolve_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        resp = await client.get(url, headers=headers, timeout=10.0)
    except Exception as exc:  # 网络类异常：连接失败、超时
        return {"id": provider_id, "ok": False, "status": 0,
                "message": f"{exc.__class__.__name__}: {str(exc)[:200]}"}
    return {
        "id": provider_id,
        "ok": resp.status_code == 200,
        "status": resp.status_code,
        "message": _test_message(resp),
    }


def _test_message(resp) -> str:
    try:
        data = resp.json()
    except ValueError:
        return resp.text[:200] or f"HTTP {resp.status_code}"
    models = data.get("data") if isinstance(data, dict) else None
    if isinstance(models, list):
        return f"OK, {len(models)} models exposed"
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return error.get("message", f"HTTP {resp.status_code}")
    return f"HTTP {resp.status_code}"
