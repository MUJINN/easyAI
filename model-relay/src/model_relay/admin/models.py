"""管理 API：模型目录（model_entries + model_backends）CRUD。

绑定的对外标识是其内部行 id（row_id），改/删绑定通过该 id 操作。
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from model_relay.api.deps import get_settings_dependency
from model_relay.auth import require_admin_key
from model_relay.config import BackendBinding, ModelEntry, Settings
from model_relay.db.catalog_repos import SqliteModelEntryRepo, SqliteProviderRepo

router = APIRouter(tags=["admin-models"])


class BindingCreateRequest(BaseModel):
    backend: str
    backend_model: str | None = None
    priority: int = Field(default=100, ge=0)
    weight: int = Field(default=1, ge=1)
    input_price_per_1k: float | None = Field(default=None, ge=0.0)
    output_price_per_1k: float | None = Field(default=None, ge=0.0)
    currency: str = "USD"
    enabled: bool = True


class BindingUpdateRequest(BaseModel):
    backend: str | None = None
    backend_model: str | None = None
    priority: int | None = Field(default=None, ge=0)
    weight: int | None = Field(default=None, ge=1)
    input_price_per_1k: float | None = None
    output_price_per_1k: float | None = None
    currency: str | None = None
    enabled: bool | None = None


class BindingInfo(BindingCreateRequest):
    """绑定视图：id 为内部行 id。"""

    id: str


class ModelCreateRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str | None = None
    owned_by: str = "easyai"
    strategy: str | None = None
    enabled: bool = True
    backends: list[BindingCreateRequest] = []


class ModelUpdateRequest(BaseModel):
    name: str | None = None
    owned_by: str | None = None
    strategy: str | None = None
    enabled: bool | None = None


class ModelInfo(BaseModel):
    id: str
    name: str | None
    owned_by: str
    strategy: str | None
    enabled: bool
    backends: list[BindingInfo]


def _to_info(entry: ModelEntry, bindings: list[tuple[str, BackendBinding]]) -> ModelInfo:
    return ModelInfo(
        id=entry.id,
        name=entry.name,
        owned_by=entry.owned_by,
        strategy=entry.strategy,
        enabled=entry.enabled,
        backends=[
            BindingInfo(
                id=row_id,
                backend=b.backend,
                backend_model=b.backend_model,
                priority=b.priority,
                weight=b.weight,
                input_price_per_1k=b.input_price_per_1k,
                output_price_per_1k=b.output_price_per_1k,
                currency=b.currency,
                enabled=b.enabled,
            )
            for row_id, b in bindings
        ],
    )


@router.get("/models", response_model=list[ModelInfo])
async def list_models(
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> list[ModelInfo]:
    """列出全部模型目录（含绑定行 id）。"""
    repo = SqliteModelEntryRepo(settings.db_path)
    result = []
    for entry in await repo.list():
        bindings = await repo.list_bindings(entry.id)
        result.append(_to_info(entry, bindings))
    return result


@router.post("/models", response_model=ModelInfo, status_code=201)
async def create_model(
    body: ModelCreateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> ModelInfo:
    """新建模型条目（可带初始绑定）。"""
    repo = SqliteModelEntryRepo(settings.db_path)
    if await repo.get(body.id):
        raise HTTPException(status_code=409, detail="Model id already exists.")
    providers = await SqliteProviderRepo(settings.db_path).list()
    known = {p.id for p in providers}
    unknown = [b.backend for b in body.backends if b.backend not in known]
    if unknown:
        raise HTTPException(
            status_code=404,
            detail=f"Backend not found: {', '.join(sorted(set(unknown)))}",
        )
    entry = ModelEntry(
        id=body.id,
        name=body.name,
        owned_by=body.owned_by,
        strategy=body.strategy,
        enabled=body.enabled,
        backends=[BackendBinding(**b.model_dump()) for b in body.backends],
    )
    await repo.create(entry)
    bindings = await repo.list_bindings(entry.id)
    return _to_info(entry, bindings)


@router.patch("/models/{model_id}", response_model=ModelInfo)
async def update_model(
    model_id: str,
    body: ModelUpdateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> ModelInfo:
    """部分更新模型条目。"""
    repo = SqliteModelEntryRepo(settings.db_path)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not await repo.update(model_id, fields):
        raise HTTPException(status_code=404, detail="Model not found.")
    entry = await repo.get(model_id)
    assert entry is not None
    bindings = await repo.list_bindings(model_id)
    return _to_info(entry, bindings)


@router.delete("/models/{model_id}")
async def delete_model(
    model_id: str,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> dict:
    """删除模型条目及其全部绑定。"""
    deleted = await SqliteModelEntryRepo(settings.db_path).delete(model_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Model not found.")
    return {"id": model_id, "status": "deleted"}


@router.post("/models/{model_id}/bindings", response_model=BindingInfo, status_code=201)
async def add_binding(
    model_id: str,
    body: BindingCreateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> BindingInfo:
    """为模型新增一个候选后端绑定。"""
    repo = SqliteModelEntryRepo(settings.db_path)
    entry = await repo.get(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Model not found.")
    providers = await SqliteProviderRepo(settings.db_path).list()
    if not any(p.id == body.backend for p in providers):
        raise HTTPException(status_code=404, detail="Backend not found.")
    row_id = await repo.add_binding(model_id, BackendBinding(**body.model_dump()))
    return BindingInfo(id=row_id, **body.model_dump())


@router.patch("/models/bindings/{binding_id}", response_model=BindingInfo)
async def update_binding(
    binding_id: str,
    body: BindingUpdateRequest,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> BindingInfo:
    """更新绑定（优先级 / 权重 / 定价 / 开关）。"""
    repo = SqliteModelEntryRepo(settings.db_path)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not await repo.update_binding(binding_id, fields):
        raise HTTPException(status_code=404, detail="Binding not found.")
    # 回读：先从所有模型中定位该绑定
    for entry in await repo.list():
        for row_id, binding in await repo.list_bindings(entry.id):
            if row_id == binding_id:
                return BindingInfo(
                    id=row_id,
                    backend=binding.backend,
                    backend_model=binding.backend_model,
                    priority=binding.priority,
                    weight=binding.weight,
                    input_price_per_1k=binding.input_price_per_1k,
                    output_price_per_1k=binding.output_price_per_1k,
                    currency=binding.currency,
                    enabled=binding.enabled,
                )
    raise HTTPException(status_code=404, detail="Binding not found.")


@router.delete("/models/bindings/{binding_id}")
async def delete_binding(
    binding_id: str,
    _: None = Depends(require_admin_key),
    settings: Settings = Depends(get_settings_dependency),
) -> dict:
    """删除绑定。"""
    deleted = await SqliteModelEntryRepo(settings.db_path).delete_binding(binding_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Binding not found.")
    return {"id": binding_id, "status": "deleted"}
