"""OpenAI 兼容的 API 数据模型。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ChatMessage(BaseModel):
    """对话消息（M2 仅支持文本 content，多模态留待后续）。"""

    role: Literal["system", "user", "assistant", "tool", "function", "developer"] = "user"
    content: str


class ChatCompletionRequest(BaseModel):
    """OpenAI 兼容的 chat/completions 请求。

    extra="allow"：未显式定义的参数（stop、n、response_format 等）
    原样保留并随 model_dump 透传给上游后端。
    """

    model_config = ConfigDict(extra="allow")

    model: str
    messages: list[ChatMessage]
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    stream: bool = False
    max_tokens: int | None = Field(default=None, ge=1)


class Usage(BaseModel):
    """Token 用量。"""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class Choice(BaseModel):
    """模型返回的选择。"""

    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    """OpenAI 兼容的 chat/completions 响应。"""

    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[Choice]
    usage: Usage


class ModelObject(BaseModel):
    """OpenAI 兼容的模型对象。"""

    id: str
    object: str = "model"
    created: int
    owned_by: str = "easyai"
