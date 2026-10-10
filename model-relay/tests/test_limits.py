"""M4：限流（令牌桶 / 三级）与并发上限。"""

import asyncio
import sqlite3

import pytest
from fastapi.testclient import TestClient

from model_relay.config import LimitsConfig
from model_relay.db.repos import KeyRecord
from model_relay.limiting import Governance, TokenBucket

ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}


# ---- 单元：TokenBucket ----

def test_token_bucket_basic():
    bucket = TokenBucket(1)
    assert bucket.allow() is True
    assert bucket.allow() is False
    assert bucket.retry_after() >= 1


def test_token_bucket_refills():
    import time as _time

    bucket = TokenBucket(60)  # 1/秒
    for _ in range(60):
        assert bucket.allow() is True
    assert bucket.allow() is False
    bucket.updated = _time.monotonic() - 1.5  # 假装过了 1.5 秒
    assert bucket.allow() is True


# ---- 单元：Governance 并发席位 ----

async def test_concurrency_slot_blocks_then_releases():
    gov = Governance()
    key = KeyRecord(
        id="k1", tenant_id="default", key_hash="h", alias=None,
        quota_requests=None, quota_amount=None, status="active",
        created_at="t", expires_at=None, rate_rpm=None, max_concurrency=1,
    )
    limits = LimitsConfig()
    slots1 = await gov.acquire_slots(key, limits)

    # 并发上限 1：第二个 acquire 应阻塞
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gov.acquire_slots(key, limits), timeout=0.05)

    gov.release_slots(slots1)
    slots2 = await asyncio.wait_for(gov.acquire_slots(key, limits), timeout=0.1)
    gov.release_slots(slots2)


async def test_concurrency_global_slot():
    gov = Governance()
    key = KeyRecord(
        id="k1", tenant_id="default", key_hash="h", alias=None,
        quota_requests=None, quota_amount=None, status="active",
        created_at="t", expires_at=None, rate_rpm=None, max_concurrency=None,
    )
    limits = LimitsConfig(global_concurrency=1)
    slots1 = await gov.acquire_slots(key, limits)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gov.acquire_slots(key, limits), timeout=0.05)
    gov.release_slots(slots1)


# ---- 集成：per-key 限流 ----

def test_key_rate_limit_429(client: TestClient):
    """rate_rpm=1：连续第二次请求被限流。"""
    resp = client.post(
        "/admin/keys",
        json={"alias": "limited", "rate_rpm": 1},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200
    key = resp.json()["key"]
    headers = {"Authorization": f"Bearer {key}"}

    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    first = client.post("/v1/chat/completions", json=payload, headers=headers)
    assert first.status_code == 200

    second = client.post("/v1/chat/completions", json=payload, headers=headers)
    assert second.status_code == 429
    error = second.json()["error"]
    assert error["code"] == "rate_limit_exceeded"
    assert "Retry-After" in second.headers


# ---- 集成：global 限流（运行期改配置立即生效）----

def test_global_rate_limit_429(client: TestClient, tmp_path, auth_headers, monkeypatch):
    # 重写配置文件启用全局限流（配置随请求热加载）
    config_path = tmp_path / "config.yaml"
    text = config_path.read_text(encoding="utf-8")
    config_path.write_text(
        text.replace(
            "routing:\n  strategy: priority",
            "routing:\n  strategy: priority\n  limits:\n    global_rpm: 1",
        ),
        encoding="utf-8",
    )

    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    first = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert first.status_code == 200
    second = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "rate_limit_exceeded"


# ---- 集成：per-backend 限流（限流改投下一个后端）----

def test_backend_rate_limit_falls_back(client: TestClient, auth_headers, db_path):
    """backend-a rpm=1：第二个请求自动改投 backend-b。"""
    resp = client.patch(
        "/admin/providers/backend-a",
        json={"rpm": 1},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200

    payload = {
        "model": "fallback-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    first = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert first.status_code == 200
    assert first.json()["choices"][0]["message"]["content"] == "Hello from A!"

    second = client.post("/v1/chat/completions", json=payload, headers=auth_headers)
    assert second.status_code == 200
    assert second.json()["choices"][0]["message"]["content"] == "Hello from B!"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT backend_id, fallback FROM requests_log").fetchall()
    conn.close()
    assert rows[0]["backend_id"] == "backend-a"
    assert rows[1]["backend_id"] == "backend-b"
    assert rows[1]["fallback"] == 1
