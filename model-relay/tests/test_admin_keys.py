"""管理 API：Key CRUD 与 Admin Key 鉴权。"""

from fastapi.testclient import TestClient

# 与 conftest.py 中 monkeypatch 的 MODEL_RELAY_ADMIN_KEY 保持一致
ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}

PAYLOAD = {
    "model": "mock-model",
    "messages": [{"role": "user", "content": "hello"}],
}


def test_admin_endpoints_require_admin_key(client: TestClient):
    assert client.post("/admin/keys", json={}).status_code == 401
    assert client.get("/admin/keys").status_code == 401
    assert client.delete("/admin/keys/abc").status_code == 401


def test_wrong_admin_key_401(client: TestClient):
    resp = client.get(
        "/admin/keys", headers={"Authorization": "Bearer sk-wrong-admin"}
    )
    assert resp.status_code == 401


def test_create_list_revoke_roundtrip(client: TestClient):
    # 创建
    resp = client.post(
        "/admin/keys",
        json={"alias": "demo", "quota_requests": 100},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["key"].startswith("sk-easyai-")
    assert body["alias"] == "demo"
    assert body["quota_requests"] == 100
    assert body["status"] == "active"
    key_id = body["id"]
    plain_key = body["key"]

    # 新 Key 立即可用于转发 API
    resp = client.post(
        "/v1/chat/completions",
        json=PAYLOAD,
        headers={"Authorization": f"Bearer {plain_key}"},
    )
    assert resp.status_code == 200

    # 列表：不暴露明文与 hash
    resp = client.get("/admin/keys", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    keys = resp.json()
    assert len(keys) == 1
    assert keys[0]["id"] == key_id
    assert "key" not in keys[0]
    assert "key_hash" not in keys[0]

    # 吊销
    resp = client.delete(f"/admin/keys/{key_id}", headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"

    # 吊销后转发 401
    resp = client.post(
        "/v1/chat/completions",
        json=PAYLOAD,
        headers={"Authorization": f"Bearer {plain_key}"},
    )
    assert resp.status_code == 401


def test_revoke_missing_key_404(client: TestClient):
    resp = client.delete("/admin/keys/nope", headers=ADMIN_HEADERS)
    assert resp.status_code == 404
