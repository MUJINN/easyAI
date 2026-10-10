"""FastAPI 公共依赖。"""

from model_relay.config import Settings, get_settings


def get_settings_dependency() -> Settings:
    """向路由注入全局 Settings 实例。"""
    return get_settings()
