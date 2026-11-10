"""FastAPI 应用入口。"""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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

# 前端构建产物目录（web/vite.config.ts 的 outDir 指向这里；未构建时仅后端模式运行）
STATIC_DIR = Path(__file__).parent / "static"

# /admin、/v1、/health 之外的路径才走 SPA 兜底（避免吞掉 API 404）
_SPA_SKIP_PREFIXES = ("admin", "v1", "health")


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
        headers = dict(exc.headers or {})
        request_id = getattr(request.state, "request_id", None)
        if request_id:
            headers["X-Request-ID"] = request_id
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.detail,
            headers=headers,
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": settings.app_version}

    # —— 静态托管（须在全部 API 路由之后注册，保证 API 优先匹配）——
    # 控制台静态资源：构建产物随包分发（requirements 10.5），无产物时跳过挂载
    if (STATIC_DIR / "assets").is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=STATIC_DIR / "assets"),
            name="assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 兜底：根路径与未知路径返回 index.html，已有静态文件直接返回。

        以 /admin、/v1、/health 开头但未匹配任何 API 路由的路径不兜底，
        维持 FastAPI 默认的 404 JSON；未构建前端时返回提示页。
        """
        if full_path.split("/", 1)[0] in _SPA_SKIP_PREFIXES:
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        if not STATIC_DIR.is_dir():
            return HTMLResponse(_hint_html(), status_code=200)
        if full_path:
            candidate = STATIC_DIR / full_path
            if candidate.is_file():
                return FileResponse(candidate)
        index = STATIC_DIR / "index.html"
        if index.is_file():
            return FileResponse(index)
        return HTMLResponse(_hint_html(), status_code=200)

    return app


def _hint_html() -> str:
    """前端尚未构建时的提示页。"""
    return """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>easyAI 控制台未构建</title>
<style>
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0f172a; color: #e2e8f0; display: flex;
         align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  main { text-align: center; max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #94a3b8; line-height: 1.7; font-size: 0.9rem; }
  code { background: #1e293b; border: 1px solid #334155; color: #7dd3fc;
         border-radius: 0.375rem; padding: 0.15rem 0.5rem; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>easyAI 管理控制台尚未构建</h1>
  <p>管理 API 已正常运行。若需使用 Web 控制台，请在 <code>web/</code> 目录执行
     <code>npm install &amp;&amp; npm run build</code> 后重启服务。</p>
</main>
</body>
</html>"""


# 模块级实例，便于 uvicorn model_relay.main:app 直接启动
app = create_app()
