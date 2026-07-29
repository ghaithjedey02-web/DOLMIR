"""Risk limits: the hard, numeric constraints the gate enforces.

These are account-relative fractions rather than currency amounts on
purpose: ``Money`` is deliberately deferred until a consumer needs its
precision/rounding semantics (Phase 1 decision), and a fraction-of-equity
model expresses "never risk more than 1% on one idea" without it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

__all__ = ["RiskLimits"]


@dataclass(frozen=True, kw_only=True, slots=True)
class RiskLimits:
    """The standing risk policy a proposal is measured against.

    ``max_risk_fraction_per_trade`` is the largest fraction of account
    equity that may be at risk on a single trade (e.g. ``0.01`` for 1%).
    ``min_reward_to_risk`` is the smallest acceptable reward-to-risk ratio
    (e.g. ``1.5``). Both are hard limits: the gate is deterministic code,
    not a debate participant (Core Architecture §8).
    """

    schema_version: ClassVar[int] = 1

    max_risk_fraction_per_trade: float
    min_reward_to_risk: float

    def __post_init__(self) -> None:
        """Reject incoherent limits at construction."""
        if not 0.0 < self.max_risk_fraction_per_trade <= 1.0:
            msg = "RiskLimits.max_risk_fraction_per_trade must be within (0.0, 1.0]"
            raise ValueError(msg)
        if self.min_reward_to_risk <= 0.0:
            msg = "RiskLimits.min_reward_to_risk must be positive"
            raise ValueError(msg)
