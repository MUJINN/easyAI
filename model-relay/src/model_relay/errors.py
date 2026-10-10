"""OpenAI 兼容的错误响应支持。

FastAPI 默认的 HTTPException 会把 detail 包成 {"detail": ...}，
而 OpenAI 客户端/SDK 期望顶层即 {"error": ...}，故自定义异常
并在应用层注册专用 handler 直接输出 error 体。
"""

from fastapi import HTTPException


class OpenAIHTTPException(HTTPException):
    """错误体为 OpenAI 格式（{"error": {...}}）的 HTTP 异常。"""

    def __init__(self, status_code: int, error: dict, headers: dict | None = None):
        super().__init__(
            status_code=status_code, detail={"error": error}, headers=headers
        )


def openai_error(
    status_code: int,
    message: str,
    error_type: str = "invalid_request_error",
    code: str | None = None,
    headers: dict | None = None,
) -> OpenAIHTTPException:
    """构造 OpenAI 格式错误异常。"""
    error: dict = {"message": message, "type": error_type}
    if code:
        error["code"] = code
    return OpenAIHTTPException(status_code, error, headers=headers)
