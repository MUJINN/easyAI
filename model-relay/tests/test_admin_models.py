"""M4：模型目录管理 API（条目 + 绑定 CRUD，变更即时生效）。"""

from fastapi.testclient import TestClient

ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}


def test_models_require_admin_key(client: TestClient):
    assert client.get("/admin/models").status_code == 401
    assert client.post("/admin/models", json={}).status_code == 401


def test_create_model_with_bindings(client: TestClient):
    resp = client.post(
        "/admin/models",
        json={
            "id": "new-model",
            "name": "New Model",
            "backends": [
                {"backend": "backend-a", "backend_model": "native-a", "priority": 10}
            ],
        },
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == "new-model"
    assert len(body["backends"]) == 1
    binding = body["backends"][0]
    assert binding["backend"] == "backend-a"
    assert binding["backend_model"] == "native-a"
    assert binding["id"]  # 内部行 id

    # 冲突
    dup = client.post(
        "/admin/models", json={"id": "new-model"}, headers=ADMIN_HEADERS
    )
    assert dup.status_code == 409

    # 绑定指向不存在的后端 → 404
    bad = client.post(
        "/admin/models",
        json={"id": "bad-model", "backends": [{"backend": "ghost"}]},
        headers=ADMIN_HEADERS,
    )
    assert bad.status_code == 404


def test_new_model_immediately_usable(client: TestClient):
    """新建模型 + 绑定后无需重启即可转发。"""
    resp = client.post(
        "/admin/models",
        json={"id": "new-model", "backends": [{"backend": "backend-a"}]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201

    key = client.post("/admin/keys", json={"alias": "x"},
                      headers=ADMIN_HEADERS).json()["key"]
    response = client.post(
        "/v1/chat/completions",
        json={"model": "new-model",
              "messages": [{"role": "user", "content": "hello"}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from A!"

    # 目录列表也包含它
    models = client.get("/v1/models").json()["data"]
    assert any(m["id"] == "new-model" for m in models)


def test_disable_model(client: TestClient):
    resp = client.post(
        "/admin/models",
        json={"id": "new-model", "backends": [{"backend": "backend-a"}]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201

    patch = client.patch(
        "/admin/models/new-model", json={"enabled": False},
        headers=ADMIN_HEADERS,
    )
    assert patch.status_code == 200
    assert patch.json()["enabled"] is False

    models = client.get("/v1/models").json()["data"]
    assert not any(m["id"] == "new-model" for m in models)

    key = client.post("/admin/keys", json={"alias": "x"},
                      headers=ADMIN_HEADERS).json()["key"]
    response = client.post(
        "/v1/chat/completions",
        json={"model": "new-model",
              "messages": [{"role": "user", "content": "hello"}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert response.status_code == 404


def test_binding_crud_affects_routing(client: TestClient):
    """新增/调整绑定改变实际路由目标。"""
    resp = client.post(
        "/admin/models",
        json={"id": "new-model", "backends": [{"backend": "backend-a"}]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201

    # 新增 backend-b 且 priority 更优 → 请求应走 B
    added = client.post(
        "/admin/models/new-model/bindings",
        json={"backend": "backend-b", "priority": 5},
        headers=ADMIN_HEADERS,
    )
    assert added.status_code == 201
    binding_b = added.json()["id"]

    key = client.post("/admin/keys", json={"alias": "x"},
                      headers=ADMIN_HEADERS).json()["key"]
    headers = {"Authorization": f"Bearer {key}"}
    payload = {"model": "new-model",
               "messages": [{"role": "user", "content": "hello"}]}

    response = client.post("/v1/chat/completions", json=payload, headers=headers)
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from B!"

    # 调整绑定：把 B 的 priority 调到 100 → 请求应走 A
    patch = client.patch(
        f"/admin/models/bindings/{binding_b}", json={"priority": 100},
        headers=ADMIN_HEADERS,
    )
    assert patch.status_code == 200
    response = client.post("/v1/chat/completions", json=payload, headers=headers)
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from A!"

    # 删除 B 绑定后列表同步
    deleted = client.delete(f"/admin/models/bindings/{binding_b}",
                            headers=ADMIN_HEADERS)
    assert deleted.status_code == 200
    models = client.get("/admin/models", headers=ADMIN_HEADERS).json()
    model = next(m for m in models if m["id"] == "new-model")
    assert len(model["backends"]) == 1
    assert model["backends"][0]["backend"] == "backend-a"


def test_delete_model(client: TestClient):
    resp = client.post(
        "/admin/models",
        json={"id": "new-model", "backends": [{"backend": "backend-a"}]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 201
    binding_id = resp.json()["backends"][0]["id"]

    deleted = client.delete("/admin/models/new-model", headers=ADMIN_HEADERS)
    assert deleted.status_code == 200

    # 绑定随之清理
    patch = client.patch(
        f"/admin/models/bindings/{binding_id}", json={"priority": 1},
        headers=ADMIN_HEADERS,
    )
    assert patch.status_code == 404

    assert client.delete("/admin/models/new-model",
                         headers=ADMIN_HEADERS).status_code == 404
