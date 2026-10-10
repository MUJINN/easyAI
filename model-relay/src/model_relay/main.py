"""FastAPI 应用入口。"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from model_relay.admin.admin import router as admin_router
from model_relay.admin.models import router as admin_models_router
from model_relay.admin.providers import router as admin_providers_router
from model_relay.admin.usage import router as admin_usage_router
from model_relay.api.v1.relay import router as relay_router
from model_relay.billing.fx import REFRESH_SECONDS, FxService
from model_relay.config import Settings, get_settings
from model_relay.db import init_db
from model_relay.db.seed import seed_if_empty
from model_relay.errors import OpenAIHTTPException
from model_relay.limiting import Governance
from model_relay.providers import ProviderRegistry


async def _fx_refresh_loop(fx: FxService) -> None:
    """每 6 小时刷新汇率（循环在 shutdown 时取消）。"""
    while True:
        await asyncio.sleep(REFRESH_SECONDS)
        await fx.update_rates()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：建库、种子导入、初始化治理/汇率/驱动注册表。"""
    settings = get_settings()
    await init_db(settings.db_path)

    # 全局路由/限流/重试参数仍读 YAML；目录（providers/entries）已迁入 DB
    config = settings.load_yaml_config()
    await seed_if_empty(settings.db_path, config)

    app.state.governance = Governance()
    app.state.fx = FxService()
    app.state.providers = ProviderRegistry()

    await app.state.fx.update_rates()  # 失败静默降级，不阻塞启动
    refresh_task = asyncio.create_task(
        _fx_refresh_loop(app.state.fx), name="fx-refresh"
    )

    try:
        yield
    finally:
        refresh_task.cancel()
        try:
            await refresh_task
        except asyncio.CancelledError:
            pass
        await app.state.providers.aclose()
        await app.state.fx.aclose()


def create_app() -> FastAPI:
    """应用工厂。"""
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="统一的 AI 模型网关 / 中转站",
        lifespan=lifespan,
    )

    app.include_router(relay_router, prefix="/v1")
    app.include_router(admin_router, prefix="/admin")
    app.include_router(admin_providers_router, prefix="/admin")
    app.include_router(admin_models_router, prefix="/admin")
    app.include_router(admin_usage_router, prefix="/admin")

    @app.exception_handler(OpenAIHTTPException)
    async def openai_http_exception_handler(
        request: Request, exc: OpenAIHTTPException
    ) -> JSONResponse:
        """顶层直接输出 {"error": ...}，而非 FastAPI 默认的 {"detail": ...}。"""
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.detail,
            headers=exc.headers,
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": settings.app_version}

    return app


# 模块级实例，便于 uvicorn model_relay.main:app 直接启动
app = create_app()
