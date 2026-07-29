"""The Risk Gate: deterministic, mandatory, zero-LLM (Core Architecture §8).

The gate is the *only* code path that can turn a ``TradeProposal`` into an
``ApprovedTrade`` — no other constructor for that type exists, enforced by a
capability token only this module holds. That is what "hard constraint"
should mean: not an LLM asked nicely to respect a limit, but plain code that
behaves identically given identical inputs, exhaustively testable with
ordinary unit tests. In the pipeline it is a mandatory terminal node and it
appears in the trace like any other step ("Risk Gate: VETOED — …").
"""

from __future__ import annotations

from dataclasses import dataclass, field

from dolmir.engines.risk_engine.domain.limits import RiskLimits
from dolmir.engines.risk_engine.domain.proposal import TradeProposal

__all__ = ["ApprovedTrade", "RiskGate", "RiskVerdict", "VetoedTrade"]

# A capability token: identity-checked so that only ``RiskGate.evaluate``
# (which lives in this module and alone can name it) can mint an
# ``ApprovedTrade``. Deliberately absent from ``__all__``.
_APPROVAL_TOKEN = object()


@dataclass(frozen=True, kw_only=True, slots=True)
class ApprovedTrade:
    """A proposal the Risk Gate approved — constructible only by the gate.

    Attempting to build one directly raises: an approved trade that did not
    pass the gate is exactly the illegal state the gate exists to prevent
    (Standing Rule 5, illegal states unrepresentable).
    """

    proposal: TradeProposal
    reward_to_risk: float
    token: object = field(default=None, repr=False)

    def __post_init__(self) -> None:
        """Reject any construction not carrying the gate's private token."""
        if self.token is not _APPROVAL_TOKEN:
            msg = (
                "ApprovedTrade can only be produced by RiskGate.evaluate(); "
                "there is no other sanctioned path from a proposal to an "
                "approved trade (Core Architecture §8)"
            )
            raise RuntimeError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class VetoedTrade:
    """A proposal the Risk Gate refused, with every reason it refused it."""

    proposal: TradeProposal
    reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        """A veto without a stated reason is not auditable — reject it."""
        if not self.reasons:
            msg = "VetoedTrade must carry at least one reason"
            raise ValueError(msg)


type RiskVerdict = ApprovedTrade | VetoedTrade


class RiskGate:
    """Approves or vetoes a proposal against hard limits — deterministically."""

    def evaluate(self, proposal: TradeProposal, limits: RiskLimits) -> RiskVerdict:
        """Return an ``ApprovedTrade`` or a ``VetoedTrade`` with its reasons."""
        reasons: list[str] = []

        if proposal.risk_fraction_of_equity > limits.max_risk_fraction_per_trade:
            reasons.append(
                f"risk per trade {proposal.risk_fraction_of_equity:.2%} exceeds the "
                f"limit of {limits.max_risk_fraction_per_trade:.2%}"
            )

        reward_to_risk = proposal.reward_to_risk
        if reward_to_risk < limits.min_reward_to_risk:
            reasons.append(
                f"reward-to-risk {reward_to_risk:.2f} is below the minimum "
                f"{limits.min_reward_to_risk:.2f}"
            )

        if reasons:
            return VetoedTrade(proposal=proposal, reasons=tuple(reasons))
        return ApprovedTrade(
            proposal=proposal, reward_to_risk=reward_to_risk, token=_APPROVAL_TOKEN
        )
