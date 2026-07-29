"""The deterministic Risk Gate — exhaustive, plain-pytest coverage.

The gate is the hardest guarantee in the system (Core Architecture §8), so
it earns the most literal tests: illegal proposals cannot be built, an
approved trade cannot be forged, and every veto reason is explicit.
"""

from __future__ import annotations

import pytest

from dolmir.engines.risk_engine import domain
from dolmir.engines.risk_engine.domain import (
    ApprovedTrade,
    RiskGate,
    RiskLimits,
    TradeDirection,
    TradeProposal,
    VetoedTrade,
)

_LIMITS = RiskLimits(max_risk_fraction_per_trade=0.01, min_reward_to_risk=1.5)


def _long(
    *, entry: float = 100.0, stop: float = 98.0, target: float = 106.0, risk: float = 0.008
) -> TradeProposal:
    return TradeProposal(
        symbol="EURUSD",
        direction=TradeDirection.LONG,
        entry=entry,
        stop=stop,
        target=target,
        risk_fraction_of_equity=risk,
    )


def test_long_requires_stop_below_and_target_above_entry() -> None:
    with pytest.raises(ValueError, match="LONG"):
        _long(stop=101.0)  # stop above entry is incoherent
    with pytest.raises(ValueError, match="LONG"):
        _long(target=99.0)  # target below entry is incoherent


def test_short_requires_target_below_and_stop_above_entry() -> None:
    with pytest.raises(ValueError, match="SHORT"):
        TradeProposal(
            symbol="EURUSD",
            direction=TradeDirection.SHORT,
            entry=100.0,
            stop=98.0,  # stop below entry is incoherent for a short
            target=94.0,
            risk_fraction_of_equity=0.005,
        )


def test_proposal_rejects_nonpositive_prices() -> None:
    with pytest.raises(ValueError, match="positive"):
        _long(stop=0.0)


def test_gate_approves_a_within_limits_trade() -> None:
    verdict = RiskGate().evaluate(_long(), _LIMITS)

    assert isinstance(verdict, ApprovedTrade)
    # reward/risk = |106-100| / |100-98| = 3.0
    assert verdict.reward_to_risk == 3.0


def test_gate_vetoes_an_over_limit_risk() -> None:
    # 2% risked against a 1% cap.
    verdict = RiskGate().evaluate(_long(risk=0.02), _LIMITS)

    assert isinstance(verdict, VetoedTrade)
    assert len(verdict.reasons) == 1
    assert "risk per trade 2.00%" in verdict.reasons[0]
    assert "1.00%" in verdict.reasons[0]


def test_gate_vetoes_a_poor_reward_to_risk() -> None:
    # reward/risk = |101-100| / |100-98| = 0.5, below the 1.5 minimum.
    verdict = RiskGate().evaluate(_long(target=101.0), _LIMITS)

    assert isinstance(verdict, VetoedTrade)
    assert "reward-to-risk 0.50" in verdict.reasons[0]


def test_gate_accumulates_every_reason() -> None:
    verdict = RiskGate().evaluate(_long(target=101.0, risk=0.05), _LIMITS)

    assert isinstance(verdict, VetoedTrade)
    assert len(verdict.reasons) == 2


def test_approved_trade_cannot_be_forged() -> None:
    with pytest.raises(RuntimeError, match="only be produced by RiskGate"):
        ApprovedTrade(proposal=_long(), reward_to_risk=3.0)


def test_gate_boundary_is_inclusive_on_limits() -> None:
    # Exactly at the risk cap and exactly at the minimum reward/risk: allowed.
    proposal = _long(entry=100.0, stop=98.0, target=103.0, risk=0.01)  # r/r = 1.5
    verdict = RiskGate().evaluate(proposal, _LIMITS)
    assert isinstance(verdict, ApprovedTrade)


def test_the_approval_token_is_not_public_api() -> None:
    # The gate mints approvals with a private token; the public API must not
    # hand it out, or the "only the gate can approve" guarantee would leak.
    assert "_APPROVAL_TOKEN" not in domain.__all__
    assert not hasattr(domain, "_APPROVAL_TOKEN")
