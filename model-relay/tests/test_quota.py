"""M4：额度扣减（次数 / 金额）、费用估算、离线降级。"""

import asyncio
import sqlite3

from fastapi.testclient import TestClient

from model_relay.db.repos import KeyRecord, SqliteRequestLogRepo
from model_relay.errors import OpenAIHTTPException

ADMIN_KEY = "sk-admin-test"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}

PAYLOAD = {
    "model": "fallback-model",
    "messages": [{"role": "user", "content": "hello"}],
}

# fallback-model 绑定定价 0.1 USD/1k（conftest），一次成功请求：
# 10 prompt + 4 completion → (10/1000 + 4/1000) × 0.1 = 0.0014 USD = 14 (×10000)
COST_PER_REQUEST = 14


def _create_key(client: TestClient, **extra) -> str:
    resp = client.post("/admin/keys", json={"alias": "q", **extra},
                       headers=ADMIN_HEADERS)
    assert resp.status_code == 200, resp.text
    return resp.json()["key"]


def _auth(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}


def _last_row(db_path: str) -> sqlite3.Row:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM requests_log ORDER BY created_at DESC, id DESC LIMIT 1"
    ).fetchall()
    conn.close()
    assert len(rows) == 1
    return rows[0]


# ---- 次数配额 ----

def test_request_quota_exhausted_402(client: TestClient, db_path):
    key = _create_key(client, quota_requests=1)

    first = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert first.status_code == 200

    second = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert second.status_code == 402
    assert second.json()["error"]["code"] == "insufficient_quota"
    assert second.headers.get("x-request-id")

    # 被拒请求不计入成功配额，但保留失败日志。
    conn = sqlite3.connect(db_path)
    success_count = conn.execute(
        "SELECT COUNT(*) FROM requests_log WHERE status = 'success'"
    ).fetchone()[0]
    log_count = conn.execute("SELECT COUNT(*) FROM requests_log").fetchone()[0]
    conn.close()
    assert success_count == 1
    assert log_count == 2


def test_request_quota_reservation_is_atomic(client: TestClient, db_path):
    created = client.post(
        "/admin/keys",
        json={"alias": "concurrent", "quota_requests": 1},
        headers=ADMIN_HEADERS,
    ).json()
    key = KeyRecord(
        id=created["id"],
        tenant_id=created["tenant_id"],
        key_hash="not-used-for-reservation",
        alias=created["alias"],
        quota_requests=created["quota_requests"],
        quota_amount=created["quota_amount"],
        status=created["status"],
        created_at=created["created_at"],
        expires_at=created["expires_at"],
    )
    repo = SqliteRequestLogRepo(db_path)

    async def reserve(reservation_id: str) -> bool:
        try:
            await repo.reserve_quota(key, reservation_id)
            return True
        except OpenAIHTTPException as exc:
            assert exc.status_code == 402
            return False

    async def reserve_both() -> list[bool]:
        return await asyncio.gather(
            reserve("reservation-a"), reserve("reservation-b")
        )

    outcomes = asyncio.run(reserve_both())
    assert sorted(outcomes) == [False, True]

    winner = "reservation-a" if outcomes[0] else "reservation-b"
    asyncio.run(repo.release_quota(winner))


def test_amount_quota_reservation_protects_inflight_balance(
    client: TestClient, db_path
):
    created = client.post(
        "/admin/keys",
        json={"alias": "amount-reservation", "quota_amount": 14},
        headers=ADMIN_HEADERS,
    ).json()
    key = KeyRecord(
        id=created["id"],
        tenant_id=created["tenant_id"],
        key_hash="not-used-for-reservation",
        alias=created["alias"],
        quota_requests=None,
        quota_amount=created["quota_amount"],
        status=created["status"],
        created_at=created["created_at"],
        expires_at=created["expires_at"],
    )
    repo = SqliteRequestLogRepo(db_path)

    async def reserve_twice() -> tuple[bool, int | None]:
        await repo.reserve_quota(key, "amount-a")
        try:
            await repo.reserve_quota(key, "amount-b")
            return True, None
        except OpenAIHTTPException as exc:
            return False, exc.status_code
        finally:
            await repo.release_quota("amount-a")

    accepted, status_code = asyncio.run(reserve_twice())
    assert accepted is False
    assert status_code == 402


def test_upstream_error_releases_request_quota(client: TestClient):
    key = _create_key(client, quota_requests=1)
    failed = client.post(
        "/v1/chat/completions",
        json={
            **PAYLOAD,
            "model": "mock-model",
            "messages": [{"role": "user", "content": "trigger-upstream-error"}],
        },
        headers=_auth(key),
    )
    assert failed.status_code == 401
    assert failed.headers.get("x-request-id")

    succeeding = client.post(
        "/v1/chat/completions",
        json={**PAYLOAD, "model": "mock-model"},
        headers=_auth(key),
    )
    assert succeeding.status_code == 200
    assert succeeding.headers.get("x-request-id")


def test_quota_topup_via_patch(client: TestClient, db_path):
    """PATCH 调整配额后请求恢复。"""
    resp = client.post("/admin/keys", json={"alias": "q", "quota_requests": 1},
                       headers=ADMIN_HEADERS)
    key_id = resp.json()["id"]
    key = resp.json()["key"]

    assert client.post("/v1/chat/completions", json=PAYLOAD,
                       headers=_auth(key)).status_code == 200
    assert client.post("/v1/chat/completions", json=PAYLOAD,
                       headers=_auth(key)).status_code == 402

    patch = client.patch(f"/admin/keys/{key_id}", json={"quota_requests": 5},
                         headers=ADMIN_HEADERS)
    assert patch.status_code == 200
    assert patch.json()["quota_requests"] == 5

    assert client.post("/v1/chat/completions", json=PAYLOAD,
                       headers=_auth(key)).status_code == 200


# ---- 金额配额与费用估算 ----

def test_amount_quota_and_cost_logged(client: TestClient, db_path):
    """金额配额 20（$0.002）：两次成功（14×2=28 ≥ 20）后第三次 402。"""
    key = _create_key(client, quota_amount=20)

    assert client.post("/v1/chat/completions", json=PAYLOAD,
                       headers=_auth(key)).status_code == 200
    assert client.post("/v1/chat/completions", json=PAYLOAD,
                       headers=_auth(key)).status_code == 200

    third = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert third.status_code == 402
    assert third.json()["error"]["code"] == "insufficient_quota"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT cost_usd FROM requests_log WHERE status = 'success'"
    ).fetchall()
    conn.close()
    assert [r["cost_usd"] for r in rows] == [COST_PER_REQUEST] * 2


def test_no_pricing_503_for_amount_quota(client: TestClient):
    """金额配额 + 所选绑定无定价 → 503 pricing_unavailable（明确提示）。"""
    key = _create_key(client, quota_amount=1000)
    payload = {
        "model": "mock-model",  # 该绑定没有定价
        "messages": [{"role": "user", "content": "hello"}],
    }
    response = client.post("/v1/chat/completions", json=payload, headers=_auth(key))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "pricing_unavailable"


def test_usd_pricing_works_offline(client: TestClient, db_path):
    """汇率服务不可用（rates 空）时，USD 定价仍可核算（离线降级）。"""
    app = client.app
    app.state.fx.rates = {}

    key = _create_key(client, quota_amount=1000)
    response = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert response.status_code == 200

    row = _last_row(db_path)
    assert row["cost_usd"] == COST_PER_REQUEST


def test_non_usd_without_fx_rate_503(client: TestClient):
    """绑定改为 CNY 定价但汇率缺失 → 503。"""
    app = client.app
    app.state.fx.rates = {}  # 模拟离线且无缓存汇率

    # 把 fallback-model 的全部绑定改成 CNY 定价（任一仍为 USD 都会兜底成功）
    models = client.get("/admin/models", headers=ADMIN_HEADERS).json()
    target = next(m for m in models if m["id"] == "fallback-model")
    for binding in target["backends"]:
        patch = client.patch(
            f"/admin/models/bindings/{binding['id']}",
            json={"currency": "CNY"},
            headers=ADMIN_HEADERS,
        )
        assert patch.status_code == 200

    key = _create_key(client, quota_amount=1000)
    response = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "pricing_unavailable"


def test_cny_pricing_with_rate_ok(client: TestClient, db_path):
    """有 CNY 汇率时，CNY 定价可核算并换算为 USD。"""
    app = client.app
    # conftest 的 fx mock 提供 CNY=7.2，此处显式声明以保证确定性
    app.state.fx.rates = {"CNY": 7.2}

    models = client.get("/admin/models", headers=ADMIN_HEADERS).json()
    target = next(m for m in models if m["id"] == "fallback-model")
    binding_id = target["backends"][0]["id"]
    assert client.patch(
        f"/admin/models/bindings/{binding_id}",
        json={"currency": "CNY"},
        headers=ADMIN_HEADERS,
    ).status_code == 200

    key = _create_key(client, quota_amount=1000)
    response = client.post("/v1/chat/completions", json=PAYLOAD, headers=_auth(key))
    assert response.status_code == 200

    # 原币费用 0.0014 CNY → USD = 0.0014 / 7.2 = 0.000194... → ×10000 ≈ 1.94 → 2
    row = _last_row(db_path)
    assert row["cost_usd"] == round(0.0014 / 7.2 * 10000)


def test_key_without_amount_quota_no_price_needed(client: TestClient):
    """未设金额配额的 Key：无定价绑定也能正常使用。"""
    payload = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }
    response = client.post(
        "/v1/chat/completions", json=payload, headers=_auth(_create_key(client))
    )
    assert response.status_code == 200
