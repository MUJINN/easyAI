"""静态托管测试：SPA 兜底、静态文件服务、API 404 不被吞、无产物提示页。"""

# 与 conftest.py 中 monkeypatch 的 MODEL_RELAY_ADMIN_KEY 保持一致
ADMIN_KEY = "sk-admin-test"


def _admin_headers():
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


def test_no_build_returns_hint(client):
    """无构建产物时：根路径返回提示页，管理/转发 API 的未知路径保持 404 JSON。"""
    resp = client.get("/")
    assert resp.status_code == 200
    assert "尚未构建" in resp.text

    resp = client.get("/admin/no-such-route")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}

    resp = client.get("/v1/no-such-route")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}

    resp = client.get("/health/extra")
    assert resp.status_code == 404


def test_spa_fallback_serves_index(static_client):
    """SPA 路由（含嵌套路径）与根路径均返回 index.html。"""
    for path in ("/", "/keys", "/models", "/some/deep/route"):
        resp = static_client.get(path)
        assert resp.status_code == 200, path
        assert resp.text == "<!doctype html><html><body>console</body></html>"


def test_static_files_served(static_client):
    """/assets 哈希资源与 /favicon.svg 直接按文件返回。"""
    resp = static_client.get("/assets/app.js")
    assert resp.status_code == 200
    assert resp.text == "console.log('app')"
    assert resp.headers["content-type"].startswith("text/javascript") or resp.headers[
        "content-type"
    ].startswith("application/javascript")

    resp = static_client.get("/favicon.svg")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg")


def test_api_still_works_with_static_present(static_client):
    """有构建产物时管理 API 正常：/admin/info 返回元数据。"""
    resp = static_client.get("/admin/info", headers=_admin_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"]
    assert body["version"]

    resp = static_client.get("/admin/info")
    assert resp.status_code == 401
