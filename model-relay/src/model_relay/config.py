"""配置加载：环境变量 + YAML 业务配置。

M4 起，providers / 模型目录运行期存于 SQLite，YAML 仅在首次启动时
作为种子导入（见 db/seed.py）。本模块中的模型同时承担两个角色：
YAML 解析与 DB 行映射后的传输对象。
"""

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class RetryConfig(BaseModel):
    """同一后端的自动重试配置（FR-6）。"""

    # 含首次调用在内的最大尝试次数
    max_attempts: int = Field(default=2, ge=1, le=5)
    base_delay: float = Field(default=0.5, ge=0.0)
    max_delay: float = Field(default=8.0, ge=0.0)


class LimitsConfig(BaseModel):
    """全局限流/并发配置；None 表示不限制。"""

    global_rpm: int | None = Field(default=None, ge=1)
    global_concurrency: int | None = Field(default=None, ge=1)


class BackendBinding(BaseModel):
    """统一模型到某个后端的一条绑定（目录中的一个候选后端）。"""

    # 指向 BackendConfig.id
    backend: str
    # 后端原生模型名，缺省等于统一模型名 id
    backend_model: str | None = None
    # 数值越小越优先；priority 策略与 fallback 链按此排序
    priority: int = 100
    # weight 策略的权重（>=1）
    weight: int = Field(default=1, ge=1)
    enabled: bool = True
    # 定价（原币、每 1000 tokens），用于费用估算与金额配额（需求 10.3）
    input_price_per_1k: float | None = Field(default=None, ge=0.0)
    output_price_per_1k: float | None = Field(default=None, ge=0.0)
    currency: str = "USD"


class ModelEntry(BaseModel):
    """模型目录中的统一模型条目。"""

    id: str
    name: str | None = None
    object: str = "model"
    created: int = 0
    owned_by: str = "easyai"
    # M3: 一组候选后端；为空表示尚未映射到真实后端
    backends: list[BackendBinding] = []
    # 路由策略：priority / round_robin / weight / random
    # 留空时使用 routing.strategy 全局默认
    strategy: str | None = None
    enabled: bool = True

    # M2 兼容：单后端写法 backend/backend_model，加载时归一化为 backends
    backend: str | None = None
    backend_model: str | None = None

    @model_validator(mode="after")
    def _backfill_legacy_backend(self) -> "ModelEntry":
        if not self.backends and self.backend:
            self.backends = [
                BackendBinding(
                    backend=self.backend,
                    backend_model=self.backend_model,
                )
            ]
        return self


class BackendConfig(BaseModel):
    """上游后端配置，支持 OpenAI 兼容协议（type=openai）。"""

    id: str
    type: str  # openai, anthropic, deepseek, gemini, ollama, openrouter...
    base_url: str | None = None
    api_key: str | None = None
    # 从环境变量名读取 API Key（如 OPENAI_API_KEY），优先于 api_key 明文
    api_key_env: str | None = None
    models: list[str] = []
    timeout: float = 60.0
    # per-后端速率限制（请求/分钟）；None 不限制
    rpm: int | None = Field(default=None, ge=1)
    # 动态开关：置 false 后该后端从所有目录候选中剔除
    enabled: bool = True

    def resolve_api_key(self) -> str | None:
        """按 api_key_env > api_key 的优先级解析 API Key。"""
        if self.api_key_env:
            return os.environ.get(self.api_key_env)
        return self.api_key


class RoutingConfig(BaseModel):
    """路由相关全局配置。"""

    # 默认策略：priority / round_robin / weight / random
    strategy: str = "priority"
    retry: RetryConfig = RetryConfig()
    limits: LimitsConfig = LimitsConfig()


class YamlConfig(BaseModel):
    """从 config.yaml 加载的业务配置（仅用于种子导入）。"""

    app: dict[str, Any] = {}
    routing: RoutingConfig = RoutingConfig()
    models: list[ModelEntry] = []
    backends: list[BackendConfig] = []


class Settings(BaseSettings):
    """环境变量层配置。"""

    model_config = SettingsConfigDict(
        env_prefix="MODEL_RELAY_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "easyAI model-relay"
    app_version: str = "0.1.0"
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "info"
    config_path: str = "config.yaml"
    admin_key: str | None = None
    db_path: str = "data/relay.db"

    def load_yaml_config(self) -> YamlConfig:
        """加载 YAML 业务配置；文件不存在时返回空默认配置。"""
        path = Path(self.config_path)
        if not path.exists():
            return YamlConfig()
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return YamlConfig(**data)


@lru_cache
def get_settings() -> Settings:
    """获取缓存的全局 Settings 实例。"""
    return Settings()
