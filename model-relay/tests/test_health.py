from fastapi.testclient import TestClient


def test_root_health(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["version"] == "0.1.0"


def test_admin_health(client: TestClient):
    response = client.get("/admin/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["admin"] == "true"
