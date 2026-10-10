"""M4：用量聚合与日志检索。"""

from fastapi.testclient import TestClient

ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}


def _chat(client: TestClient, headers: dict, model: str = "mock-model",
           content: str = "hello", status: str | None = None):
    resp = client.post(
        "/v1/chat/completions",
        json={"model": model,
              "messages": [{"role": "user", "content": content}]},
        headers=headers,
    )
    if status is not None:
        assert resp.status_code == status
    return resp


def test_usage_requires_admin_key(client: TestClient):
    assert client.get("/admin/usage").status_code == 401
    assert client.get("/admin/logs").status_code == 401


def test_usage_grouped_by_model(client: TestClient, api_key):
    headers = {"Authorization": f"Bearer {api_key}"}
    _chat(client, headers, model="mock-model")
    _chat(client, headers, model="mock-model")
    _chat(client, headers, model="fallback-model")

    rows = client.get("/admin/usage?group_by=model",
                      headers=ADMIN_HEADERS).json()
    by_model = {r["dim"]: r for r in rows}
    assert by_model["mock-model"]["requests"] == 2
    assert by_model["mock-model"]["prompt_tokens"] == 20
    assert by_model["mock-model"]["completion_tokens"] == 8
    assert by_model["fallback-model"]["requests"] == 1
    # mock-model 无定价 → cost 0；fallback-model 有定价 → cost 14
    assert by_model["mock-model"]["cost_usd"] == 0
    assert by_model["fallback-model"]["cost_usd"] == 14


def test_usage_grouped_by_key_and_backend(client: TestClient, api_key):
    headers = {"Authorization": f"Bearer {api_key}"}
    _chat(client, headers, model="mock-model")

    rows = client.get("/admin/usage?group_by=key", headers=ADMIN_HEADERS).json()
    assert len(rows) == 1
    assert rows[0]["requests"] == 1

    rows = client.get("/admin/usage?group_by=backend", headers=ADMIN_HEADERS).json()
    assert any(r["dim"] == "mock-backend" for r in rows)


def test_usage_time_range(client: TestClient, api_key):
    headers = {"Authorization": f"Bearer {api_key}"}
    _chat(client, headers)

    rows = client.get(
        "/admin/usage?group_by=model&start=2099-01-01T00:00:00Z",
        headers=ADMIN_HEADERS,
    ).json()
    assert rows == []

    rows = client.get(
        "/admin/usage?group_by=model&end=2099-01-01T00:00:00Z",
        headers=ADMIN_HEADERS,
    ).json()
    assert any(r["requests"] >= 1 for r in rows)


def test_logs_filters_and_pagination(client: TestClient, api_key):
    headers = {"Authorization": f"Bearer {api_key}"}
    _chat(client, headers, model="mock-model", content="hello")
    _chat(client, headers, model="mock-model", content="trigger-upstream-error",
          status=401)

    # 按状态过滤
    ok = client.get("/admin/logs?status=success", headers=ADMIN_HEADERS).json()
    assert ok["total"] == 1
    assert ok["items"][0]["status"] == "success"
    assert ok["items"][0]["backend_id"] == "mock-backend"

    err = client.get("/admin/logs?status=error", headers=ADMIN_HEADERS).json()
    assert err["total"] == 1
    assert err["items"][0]["error_type"] == "backend_401"

    # 按模型过滤
    by_model = client.get("/admin/logs?model=mock-model",
                          headers=ADMIN_HEADERS).json()
    assert by_model["total"] == 2

    # 分页
    page = client.get("/admin/logs?limit=1&offset=1", headers=ADMIN_HEADERS).json()
    assert page["total"] == 2
    assert len(page["items"]) == 1

    # 按请求 id 检索（trace 定位）
    log_id = ok["items"][0]["id"]
    traced = client.get(f"/admin/logs?id={log_id}", headers=ADMIN_HEADERS).json()
    assert traced["total"] == 1
    assert traced["items"][0]["id"] == log_id


def test_logs_include_cost_and_fallback(client: TestClient, auth_headers):
    """日志记录费用与 fallback 标记。"""
    _chat(client, auth_headers, model="fallback-model", content="fail-429")
    _chat(client, auth_headers, model="fallback-model", content="hello")

    logs = client.get("/admin/logs?model=fallback-model",
                      headers=ADMIN_HEADERS).json()
    items = logs["items"]
    assert len(items) == 2
    # fail-429：fallback 到 B，费用 14，attempts=2
    fb = next(i for i in items if i["attempts"] == 2)
    assert fb["status"] == "success"
    assert fb["cost_usd"] == 14
    assert fb["fallback"] is True
    # hello：主后端成功，attempts=1
    direct = next(i for i in items if i["attempts"] == 1)
    assert direct["cost_usd"] == 14
    assert direct["fallback"] is False
