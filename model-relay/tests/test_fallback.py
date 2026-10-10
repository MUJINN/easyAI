"""M3：多后端 fallback、动态开关与 fallback 记账。"""

import sqlite3

from fastapi.testclient import TestClient


def _payload(model: str, content: str, stream: bool = False) -> dict:
    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": stream,
    }


def _read_log(db_path: str) -> sqlite3.Row:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    return rows[0]


def test_primary_success_no_fallback(client: TestClient, auth_headers, db_path):
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "hello"),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from A!"
    row = _read_log(db_path)
    assert row["backend_id"] == "backend-a"
    assert row["fallback"] == 0
    assert row["attempts"] == 1


def test_fallback_on_429(client: TestClient, auth_headers, db_path):
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-429"),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from B!"
    row = _read_log(db_path)
    assert row["backend_id"] == "backend-b"
    assert row["status"] == "success"
    assert row["fallback"] == 1
    assert row["attempts"] == 2


def test_fallback_on_500(client: TestClient, auth_headers):
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-500"),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert "Hello from B!" in response.text


def test_fallback_on_connection_error(client: TestClient, auth_headers):
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-conn"),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from B!"


def test_no_fallback_on_400(client: TestClient, auth_headers, db_path):
    """400 属于不可重试错误：立即透传，不尝试备用后端。"""
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-400"),
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert response.json()["error"]["message"] == "A fails with 400"
    row = _read_log(db_path)
    assert row["backend_id"] == "backend-a"
    assert row["attempts"] == 1
    assert row["fallback"] == 0


def test_all_backends_fail_returns_last_error(
    client: TestClient, auth_headers, db_path
):
    """所有后端都失败：返回最后一个错误，记录全部尝试。"""
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-all"),
        headers=auth_headers,
    )
    assert response.status_code == 503
    assert response.json()["error"]["message"] == "B unavailable"
    row = _read_log(db_path)
    assert row["status"] == "error"
    assert row["attempts"] == 2
    assert row["fallback"] == 1
    assert row["error_type"] == "backend_503"


def test_stream_fallback_before_first_frame(
    client: TestClient, auth_headers, db_path
):
    """流式：上游在首帧前拒绝（429），改投备用后端，SSE 正常返回。"""
    response = client.post(
        "/v1/chat/completions",
        json=_payload("fallback-model", "fail-429", stream=True),
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "Hello from B!" in response.text
    assert "data: [DONE]" in response.text
    row = _read_log(db_path)
    assert row["backend_id"] == "backend-b"
    assert row["fallback"] == 1
    assert row["attempts"] == 2


def test_round_robin_distributes(client: TestClient, auth_headers, db_path):
    """round-robin：连续请求在两个后端间轮转。"""
    first = client.post(
        "/v1/chat/completions",
        json=_payload("rr-model", "hello"),
        headers=auth_headers,
    )
    second = client.post(
        "/v1/chat/completions",
        json=_payload("rr-model", "hello"),
        headers=auth_headers,
    )
    assert first.json()["choices"][0]["message"]["content"] == "Hello from A!"
    assert second.json()["choices"][0]["message"]["content"] == "Hello from B!"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT backend_id, fallback FROM requests_log ORDER BY created_at"
    ).fetchall()
    conn.close()
    assert [r["backend_id"] for r in rows] == ["backend-a", "backend-b"]
    assert all(r["fallback"] == 0 for r in rows)


def test_all_bindings_disabled_404(client: TestClient, auth_headers):
    response = client.post(
        "/v1/chat/completions",
        json=_payload("disabled-model", "hello"),
        headers=auth_headers,
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "model_not_found"


def test_backend_disabled_404(client: TestClient, auth_headers):
    """后端整体 enabled=false：目录引用它视同无可用后端。"""
    response = client.post(
        "/v1/chat/completions",
        json=_payload("dead-backend-model", "hello"),
        headers=auth_headers,
    )
    assert response.status_code == 404


def test_models_list_excludes_unavailable(client: TestClient):
    response = client.get("/v1/models")
    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["data"]}
    assert "mock-model" in ids
    assert "fallback-model" in ids
    assert "rr-model" in ids
    # 所有绑定禁用 / 后端已下架的模型不出现在目录中
    assert "disabled-model" not in ids
    assert "dead-backend-model" not in ids
