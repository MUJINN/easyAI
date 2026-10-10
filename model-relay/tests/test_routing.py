"""M3 路由策略与目录解析的单元测试（不经过 HTTP）。"""

import pytest

from model_relay.config import (
    BackendBinding,
    BackendConfig,
    ModelEntry,
    RoutingConfig,
    YamlConfig,
)
from model_relay.routing import (
    PRIORITY,
    RANDOM,
    ROUND_ROBIN,
    WEIGHT,
    active_bindings,
    reset_round_robin,
    select_order,
    select_strategy,
)


def _binding(backend: str, **kw) -> BackendBinding:
    return BackendBinding(backend=backend, **kw)


def _backends() -> dict[str, BackendConfig]:
    return {
        "a": BackendConfig(id="a", type="openai"),
        "b": BackendConfig(id="b", type="openai"),
        "c": BackendConfig(id="c", type="openai"),
    }


def test_legacy_single_backend_backfilled():
    entry = ModelEntry(id="m", backend="a", backend_model="native")
    assert len(entry.backends) == 1
    assert entry.backends[0].backend == "a"
    assert entry.backends[0].backend_model == "native"


def test_active_bindings_filters():
    entry = ModelEntry(
        id="m",
        backends=[
            _binding("a"),
            _binding("b", enabled=False),
            _binding("missing-backend"),
        ],
    )
    backends = {
        "a": BackendConfig(id="a", type="openai"),
        "b": BackendConfig(id="b", type="openai", enabled=False),
    }
    active = active_bindings(entry, backends)
    assert [b.backend for b in active] == ["a"]


def test_active_bindings_entry_disabled():
    entry = ModelEntry(id="m", enabled=False, backends=[_binding("a")])
    assert active_bindings(entry, _backends()) == []


def test_priority_strategy_sorts():
    entry = ModelEntry(
        id="m",
        backends=[
            _binding("a", priority=20),
            _binding("b", priority=10),
            _binding("c", priority=20),
        ],
    )
    order = select_order(entry, entry.backends, PRIORITY)
    assert [b.backend for b in order] == ["b", "a", "c"]


def test_round_robin_rotates():
    reset_round_robin()
    bindings = [_binding("a"), _binding("b"), _binding("c")]
    entry = ModelEntry(id="rr", backends=bindings)
    first = select_order(entry, bindings, ROUND_ROBIN)
    second = select_order(entry, bindings, ROUND_ROBIN)
    third = select_order(entry, bindings, ROUND_ROBIN)
    assert [b.backend for b in first] == ["a", "b", "c"]
    assert [b.backend for b in second] == ["b", "c", "a"]
    assert [b.backend for b in third] == ["c", "a", "b"]


def test_random_strategy_keeps_all_candidates(monkeypatch):
    bindings = [_binding("a"), _binding("b"), _binding("c")]
    entry = ModelEntry(id="rand", backends=bindings)
    monkeypatch.setattr("model_relay.routing.random.randrange", lambda n: 2)
    order = select_order(entry, bindings, RANDOM)
    assert [b.backend for b in order] == ["c", "a", "b"]


def test_weight_strategy(monkeypatch):
    bindings = [
        _binding("a", weight=1, priority=10),
        _binding("b", weight=1, priority=20),
        _binding("c", weight=1, priority=30),
    ]
    entry = ModelEntry(id="w", backends=bindings)
    monkeypatch.setattr(
        "model_relay.routing.random.choices",
        lambda population, weights, k: [2],
    )
    order = select_order(entry, bindings, WEIGHT)
    assert order[0].backend == "c"
    # 其余按优先级补全为 fallback 链
    assert [b.backend for b in order[1:]] == ["a", "b"]


def test_select_strategy_precedence():
    config = YamlConfig(routing=RoutingConfig(strategy=ROUND_ROBIN))
    entry = ModelEntry(id="m", strategy=WEIGHT)
    assert select_strategy(entry, config.routing.strategy) == WEIGHT

    entry_default = ModelEntry(id="m")
    assert select_strategy(entry_default, config.routing.strategy) == ROUND_ROBIN

    entry_bad = ModelEntry(id="m", strategy="nonsense")
    assert select_strategy(entry_bad, config.routing.strategy) == PRIORITY


def test_select_order_empty():
    entry = ModelEntry(id="m")
    assert select_order(entry, [], PRIORITY) == []


@pytest.mark.parametrize(
    "status,expected",
    [(429, True), (500, True), (503, True), (502, True), (408, True),
     (400, False), (401, False), (403, False), (404, False)],
)
def test_backend_error_retriable(status, expected):
    from model_relay.providers.openai_compat import BackendError

    exc = BackendError(status, {"error": {}})
    assert exc.retriable is expected


def test_backend_error_retry_after():
    import httpx

    from model_relay.providers.openai_compat import BackendError

    exc = BackendError(429, {"error": {}}, httpx.Headers({"Retry-After": "2"}))
    assert exc.retry_after() == 2.0

    exc_no_header = BackendError(429, {"error": {}})
    assert exc_no_header.retry_after() is None
