"""SSE 流式转发测试。"""

import sqlite3

from fastapi.testclient import TestClient


def _stream_payload(content: str = "hello") -> dict:
    return {
        "model": "mock-model",
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }


def test_stream_sse_transparent(client: TestClient, auth_headers):
    """逐帧透传：chunk 帧、usage 帧、[DONE] 帧完整回传。"""
    response = client.post(
        "/v1/chat/completions", json=_stream_payload(), headers=auth_headers
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    lines = [line for line in response.text.splitlines() if line.startswith("data:")]
    assert lines[-1] == "data: [DONE]"
    assert any('"delta"' in line for line in lines)
    assert any('"usage"' in line for line in lines)
    # 两个内容帧 + usage 帧 + DONE
    assert len(lines) == 4


def test_stream_usage_frame_logged(client: TestClient, auth_headers, db_path):
    """上游提供 usage 帧：精确记账，不标记估算。"""
    response = client.post(
        "/v1/chat/completions", json=_stream_payload(), headers=auth_headers
    )
    assert response.status_code == 200

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["status"] == "success"
    assert rows[0]["prompt_tokens"] == 10
    assert rows[0]["completion_tokens"] == 2
    assert rows[0]["tokens_estimated"] == 0


def test_stream_without_usage_estimated(client: TestClient, auth_headers, db_path):
    """上游无 usage 帧（如 Ollama）：按字符数粗估并标记。"""
    response = client.post(
        "/v1/chat/completions",
        json=_stream_payload("no-usage"),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert "data: [DONE]" in response.text

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["status"] == "success"
    assert rows[0]["tokens_estimated"] == 1
    # "Hel" + "lo" = 5 字符 → 粗估 1 token
    assert rows[0]["completion_tokens"] == 1


def test_stream_upstream_error_before_stream(client: TestClient, auth_headers, db_path):
    """上游在流开始前拒绝（4xx）：以 JSON 错误返回，而非 SSE。"""
    response = client.post(
        "/v1/chat/completions",
        json=_stream_payload("trigger-upstream-error"),
        headers=auth_headers,
    )
    assert response.status_code == 401
    assert response.json()["error"]["message"] == "upstream says no"
    assert "text/event-stream" not in response.headers.get("content-type", "")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["status"] == "error"
    assert rows[0]["error_type"] == "backend_401"
