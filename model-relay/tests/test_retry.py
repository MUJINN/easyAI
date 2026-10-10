"""M4：同一后端自动重试（指数退避 + Retry-After）与集成。"""

import pytest

from model_relay.config import RetryConfig
from model_relay.providers.openai_compat import BackendError
from model_relay.retrying import with_retry


def _err(status: int, headers=None) -> BackendError:
    return BackendError(status, {"error": {}}, headers)


async def test_retry_succeeds_after_transient_failures():
    """500 连续两次，第三次成功；退避按指数递增。"""
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        if calls < 3:
            raise _err(500)
        return "ok"

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=5, base_delay=1.0, max_delay=10.0)
    result = await with_retry(call, config, sleeper=fake_sleep, jitter=lambda: 0.0)
    assert result == "ok"
    assert calls == 3
    assert sleeps == [1.0, 2.0]  # base * 2**n


async def test_retry_exhausted_raises_last_error():
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        raise _err(500)

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=3, base_delay=1.0, max_delay=10.0)
    with pytest.raises(BackendError) as excinfo:
        await with_retry(call, config, sleeper=fake_sleep, jitter=lambda: 0.0)
    assert excinfo.value.status_code == 500
    assert calls == 3
    assert sleeps == [1.0, 2.0]


async def test_retry_after_honored():
    """429 带 Retry-After 时以其为准（受 max_delay 封顶）。"""
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        raise _err(429, {"Retry-After": "5"})

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=2, base_delay=0.5, max_delay=3.0)
    with pytest.raises(BackendError):
        await with_retry(call, config, sleeper=fake_sleep)
    assert sleeps == [3.0]  # Retry-After 5 被 max_delay 3 封顶


async def test_retry_after_capped():
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        raise _err(429, {"Retry-After": "0.1"})

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=2, base_delay=0.5, max_delay=3.0)
    with pytest.raises(BackendError):
        await with_retry(call, config, sleeper=fake_sleep)
    assert sleeps == [0.1]  # Retry-After 优先于退避


async def test_non_retriable_no_retry():
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        raise _err(400)

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=3, base_delay=0.5, max_delay=8.0)
    with pytest.raises(BackendError) as excinfo:
        await with_retry(call, config, sleeper=fake_sleep)
    assert excinfo.value.status_code == 400
    assert calls == 1
    assert sleeps == []


async def test_success_first_try_no_sleep():
    calls = 0
    sleeps = []

    async def call():
        nonlocal calls
        calls += 1
        return "ok"

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    config = RetryConfig(max_attempts=3, base_delay=0.5, max_delay=8.0)
    result = await with_retry(call, config, sleeper=fake_sleep)
    assert result == "ok"
    assert calls == 1
    assert sleeps == []


# ---- 集成：通过 HTTP 全链路 ----

from fastapi.testclient import TestClient  # noqa: E402

import sqlite3  # noqa: E402


def test_retry_recovers_from_transient(client: TestClient, auth_headers, db_path):
    """上游首次 500、随后成功：不 fallback，直接重试成功。"""
    payload = {
        "model": "fallback-model",
        "messages": [{"role": "user", "content": "retry-once"}],
    }
    response = client.post(
        "/v1/chat/completions", json=payload, headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from A!"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM requests_log").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["backend_id"] == "backend-a"
    assert rows[0]["fallback"] == 0  # 重试不是 fallback
    assert rows[0]["attempts"] == 1
    assert rows[0]["status"] == "success"


def test_retry_after_then_fallback(client: TestClient, auth_headers):
    """后端持续 429（带 Retry-After）：重试用尽后 fallback。"""
    payload = {
        "model": "fallback-model",
        "messages": [{"role": "user", "content": "retry-after"}],
    }
    response = client.post(
        "/v1/chat/completions", json=payload, headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Hello from B!"
