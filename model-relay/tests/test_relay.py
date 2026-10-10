"""转发 API：模型目录、非流式转发、错误透传与记账。"""

import sqlite3

from fastapi.testclient import TestClient


def test_list_models(client: TestClient):
    response = client.get("/v1/models")
    assert response.status_code == 200
    data = response.json()
    assert data["object"] == "list"
    assert isinstance(data["data"], list)
    assert any(m["id"] == "mock-model" for m in data["data"])


def test_chat_completions_non_stream(client: TestClient, auth_headers):
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
        "stream": False,
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["object"] == "chat.completion"
    assert data["model"] == "mock-model"
    assert len(data["choices"]) == 1
    assert data["choices"][0]["message"]["role"] == "assistant"
    assert data["choices"][0]["message"]["content"] == "Hello from mock!"
    assert data["usage"]["prompt_tokens"] == 10
    assert data["usage"]["completion_tokens"] == 4


def test_model_not_found_404(client: TestClient, auth_headers):
    payload = {
        "model": "nonexistent-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "model_not_found"


def test_extra_params_passthrough(client: TestClient, auth_headers):
    """未定义的 OpenAI 参数应原样透传（上游 mock 不校验，仅验证不被 422 拒绝）。"""
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
        "response_format": {"type": "json_object"},
        "stop": ["\n"],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 200


def test_upstream_error_passthrough(client: TestClient, auth_headers):
    """上游非 2xx：状态码与错误体透传。"""
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "trigger-upstream-error"}],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 401
    assert response.json()["error"]["message"] == "upstream says no"


def test_request_logged(client: TestClient, auth_headers, db_path):
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 200

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["model"] == "mock-model"
    assert rows[0]["backend_id"] == "mock-backend"
    assert rows[0]["status"] == "success"
    assert rows[0]["prompt_tokens"] == 10
    assert rows[0]["completion_tokens"] == 4
    assert rows[0]["tokens_estimated"] == 0
    assert rows[0]["access_key_id"] is not None


def test_failed_request_logged(client: TestClient, auth_headers, db_path):
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "trigger-upstream-error"}],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert response.status_code == 401

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["status"] == "error"
    assert rows[0]["error_type"] == "backend_401"
