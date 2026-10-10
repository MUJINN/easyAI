"""转发 API 鉴权测试。"""

from fastapi.testclient import TestClient

PAYLOAD = {
    "model": "mock-model",
    "messages": [{"role": "user", "content": "hello"}],
}


def test_missing_key_401(client: TestClient):
    resp = client.post("/v1/chat/completions", json=PAYLOAD)
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "invalid_api_key"


def test_wrong_key_401(client: TestClient):
    resp = client.post(
        "/v1/chat/completions",
        json=PAYLOAD,
        headers={"Authorization": "Bearer sk-wrong-key"},
    )
    assert resp.status_code == 401


def test_malformed_header_401(client: TestClient):
    resp = client.post(
        "/v1/chat/completions",
        json=PAYLOAD,
        headers={"Authorization": "Basic abc"},
    )
    assert resp.status_code == 401


def test_empty_bearer_401(client: TestClient):
    resp = client.post(
        "/v1/chat/completions",
        json=PAYLOAD,
        headers={"Authorization": "Bearer "},
    )
    assert resp.status_code == 401


def test_valid_key_ok(client: TestClient, auth_headers):
    resp = client.post(
        "/v1/chat/completions", json=PAYLOAD, headers=auth_headers
    )
    assert resp.status_code == 200
