"""M4：后端管理 API（CRUD + 连通性测试 + 级联清理）。"""

from fastapi.testclient import TestClient

ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}


def test_providers_require_admin_key(client: TestClient):
    assert client.get("/admin/providers").status_code == 401
    assert client.post("/admin/providers", json={}).status_code == 401


def test_create_list_update(client: TestClient):
    resp = client.post(
        "/admin/providers",
        json={
            "id": "mock-c",
            "type": "openai",
            "base_url": "https://mock-c/v1",
            "api_key_env": "MOCK_C_KEY",
            "rpm": 30,
        },
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == "mock-c"
    assert body["has_api_key"] is True
    assert body["rpm"] == 30
    assert body["enabled"] is True
    assert "api_key" not in body  # 不回显明文

    listed = client.get("/admin/providers", headers=ADMIN_HEADERS).json()
    assert any(p["id"] == "mock-c" for p in listed)

    # 冲突
    dup = client.post(
        "/admin/providers", json={"id": "mock-c", "type": "openai"},
        headers=ADMIN_HEADERS,
    )
    assert dup.status_code == 409

    # 部分更新
    patch = client.patch(
        "/admin/providers/mock-c",
        json={"rpm": 5, "enabled": False},
        headers=ADMIN_HEADERS,
    )
    assert patch.status_code == 200
    assert patch.json()["rpm"] == 5
    assert patch.json()["enabled"] is False

    # 404
    assert client.patch(
        "/admin/providers/nope", json={"rpm": 1}, headers=ADMIN_HEADERS
    ).status_code == 404


def test_disable_provider_takes_effect(client: TestClient):
    """PATCH enabled=false 后，引用它的模型从目录消失并 404。"""
    resp = client.patch(
        "/admin/providers/mock-backend",
        json={"enabled": False},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200

    models = client.get("/v1/models").json()
    assert not any(m["id"] == "mock-model" for m in models["data"])

    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    key = client.post("/admin/keys", json={"alias": "x"},
                      headers=ADMIN_HEADERS).json()["key"]
    response = client.post(
        "/v1/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {key}"},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "model_not_found"


def test_delete_provider_cascades_bindings(client: TestClient):
    """删除后端：引用它的绑定被级联清理。"""
    # 先建一个引用 mock-c 的模型
    resp = client.post(
        "/admin/providers",
        json={"id": "mock-c", "type": "openai", "base_url": "https://mock-c/v1"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201
    resp = client.post(
        "/admin/models",
        json={"id": "model-c", "backends": [{"backend": "mock-c"}]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201
    binding_id = resp.json()["backends"][0]["id"]

    deleted = client.delete("/admin/providers/mock-c", headers=ADMIN_HEADERS)
    assert deleted.status_code == 200

    # 绑定已级联删除
    models = client.get("/admin/models", headers=ADMIN_HEADERS).json()
    model_c = next(m for m in models if m["id"] == "model-c")
    assert model_c["backends"] == []

    # 原绑定行 id 不存在了
    patch = client.patch(
        f"/admin/models/bindings/{binding_id}", json={"priority": 1},
        headers=ADMIN_HEADERS,
    )
    assert patch.status_code == 404

    assert client.delete("/admin/providers/mock-c",
                         headers=ADMIN_HEADERS).status_code == 404


def test_provider_connectivity(client: TestClient):
    """连通性测试：mock-a 通过 /models；未知主机失败。"""
    ok = client.post("/admin/providers/backend-a/test", headers=ADMIN_HEADERS)
    assert ok.status_code == 200
    body = ok.json()
    assert body["ok"] is True
    assert body["status"] == 200
    assert "models" in body["message"]

    bad = client.post("/admin/providers/disabled-backend/test",
                      headers=ADMIN_HEADERS)
    assert bad.status_code == 200
    assert bad.json()["ok"] is False

    missing = client.post("/admin/providers/nope/test", headers=ADMIN_HEADERS)
    assert missing.status_code == 404
