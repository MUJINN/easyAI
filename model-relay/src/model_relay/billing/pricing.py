"""定价与费用估算。

费用（原币）= prompt_tokens/1000 × input_price
             + completion_tokens/1000 × output_price
再经 FxService 统一换算为 USD×10000 整数存储（需求 10.3）。
所有金额均为估算，仅供参考。
"""

from model_relay.billing.fx import FxService
from model_relay.config import BackendBinding


def is_priceable(binding: BackendBinding, fx: FxService) -> bool:
    """该绑定在当前汇率条件下能否核算费用。"""
    if binding.input_price_per_1k is None or binding.output_price_per_1k is None:
        return False
    return binding.currency.upper() == "USD" or binding.currency.upper() in fx.rates


def estimate_cost_x10000(
    binding: BackendBinding,
    prompt_tokens: int,
    completion_tokens: int,
    fx: FxService,
) -> int | None:
    """按本次用量估算 USD×10000 费用；无定价或汇率缺失返回 None。"""
    if binding.input_price_per_1k is None or binding.output_price_per_1k is None:
        return None
    original = (
        prompt_tokens / 1000.0 * binding.input_price_per_1k
        + completion_tokens / 1000.0 * binding.output_price_per_1k
    )
    return fx.to_usd_x10000(original, binding.currency)
