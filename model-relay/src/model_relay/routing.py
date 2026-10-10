"""路由策略。

给定模型条目与其可用绑定，产出本次请求的后端尝试顺序（fallback 链）：
- priority（默认）：按 priority 升序，同序保持配置中的先后
- round_robin：在候选间轮转起点，其余顺序补全为 fallback 链
- weight：按权重随机选首个，其余按优先级补全
- random：等概率随机选首个

价格优先 / 延迟优先需要价格元数据与延迟统计，留待后续里程碑。
请求级后缀（model:strategy@backend）为 P1，本里程碑暂不解析。
"""

import random
from collections import defaultdict

from model_relay.config import BackendBinding, BackendConfig, ModelEntry

PRIORITY = "priority"
ROUND_ROBIN = "round_robin"
WEIGHT = "weight"
RANDOM = "random"

STRATEGIES = (PRIORITY, ROUND_ROBIN, WEIGHT, RANDOM)

# round-robin 轮转计数：进程内、按统一模型名各自计数
_rr_counters: dict[str, int] = defaultdict(int)


def active_bindings(
    entry: ModelEntry, backends: dict[str, BackendConfig]
) -> list[BackendBinding]:
    """返回该模型当前可用的绑定：模型与绑定启用，后端存在并启用（保持配置顺序）。"""
    if not entry.enabled:
        return []
    result = []
    for binding in entry.backends:
        if not binding.enabled:
            continue
        backend = backends.get(binding.backend)
        if backend is None or not backend.enabled:
            continue
        result.append(binding)
    return result


def select_strategy(entry: ModelEntry, default: str) -> str:
    """条目策略优先，未知策略回退到全局默认，再回退到 priority。"""
    strategy = entry.strategy or default
    return strategy if strategy in STRATEGIES else PRIORITY


def select_order(
    entry: ModelEntry,
    bindings: list[BackendBinding],
    strategy: str,
) -> list[BackendBinding]:
    """按策略返回本次请求的后端尝试顺序。"""
    if not bindings:
        return []
    if strategy == ROUND_ROBIN:
        index = _rr_counters[entry.id] % len(bindings)
        _rr_counters[entry.id] += 1
        return _rotate(bindings, index)
    if strategy == RANDOM:
        return _rotate(bindings, random.randrange(len(bindings)))
    if strategy == WEIGHT:
        index = _weighted_index(bindings)
        chosen = bindings[index]
        rest = sorted(
            (b for i, b in enumerate(bindings) if i != index),
            key=lambda b: b.priority,
        )
        return [chosen, *rest]
    # priority：稳定排序保留同序时的配置顺序
    return sorted(bindings, key=lambda b: b.priority)


def reset_round_robin() -> None:
    """清空轮转计数（测试用）。"""
    _rr_counters.clear()


def _rotate(items: list, index: int) -> list:
    return [*items[index:], *items[:index]]


def _weighted_index(bindings: list[BackendBinding]) -> int:
    return random.choices(
        range(len(bindings)), weights=[b.weight for b in bindings], k=1
    )[0]
