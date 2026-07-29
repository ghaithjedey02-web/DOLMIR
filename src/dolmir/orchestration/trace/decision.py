"""Generic risk and decision objects: acting on a conclusion, gated.

A ``Conclusion`` is epistemic — what the run believes. A ``Decision`` is
pragmatic — what to do about it, given explicitly assessed risk. Keeping
them distinct is what lets a domain gate (the trading Risk Gate of Core
Architecture §8, a safety interlock in robotics, a contraindication check
in medicine) sit *between* believing and acting.

The generic law, enforced structurally (Standing Rule 5): an action-taking
``Decision`` cannot be constructed over an unacceptable ``RiskAssessment``.
Domain gates decide what "acceptable" means; the cognitive kernel makes
"act despite unacceptable risk" unrepresentable.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import ClassVar

from dolmir.orchestration.trace.conclusion import Conclusion

__all__ = ["Decision", "IdentifiedRisk", "RiskAssessment", "RiskMagnitude"]


class RiskMagnitude(enum.IntEnum):
    """How bad it is if a risk materializes, in increasing order."""

    LOW = 1
    MODERATE = 2
    HIGH = 3
    CRITICAL = 4


@dataclass(frozen=True, kw_only=True, slots=True)
class IdentifiedRisk:
    """One named downside of acting, with its mitigation if any."""

    description: str
    magnitude: RiskMagnitude
    mitigation: str | None = None

    def __post_init__(self) -> None:
        """Reject empty descriptions and empty-but-present mitigations."""
        if not self.description.strip():
            msg = "IdentifiedRisk.description must be non-empty"
            raise ValueError(msg)
        if self.mitigation is not None and not self.mitigation.strip():
            msg = "IdentifiedRisk.mitigation, when given, must be non-empty"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class RiskAssessment:
    """The explicit risk verdict a decision is gated on.

    Structural rule: an assessment cannot declare itself ``acceptable``
    while carrying an unmitigated ``CRITICAL`` risk — whatever the domain,
    that combination is a contradiction, not a judgment call.
    """

    schema_version: ClassVar[int] = 1

    risks: tuple[IdentifiedRisk, ...]
    acceptable: bool
    basis: str

    def __post_init__(self) -> None:
        """Enforce explainability and the critical-risk contradiction rule."""
        if not self.basis.strip():
            msg = "RiskAssessment.basis must be non-empty (CC §11)"
            raise ValueError(msg)
        if self.acceptable and any(
            risk.magnitude is RiskMagnitude.CRITICAL and risk.mitigation is None
            for risk in self.risks
        ):
            msg = (
                "a RiskAssessment cannot be acceptable while carrying an unmitigated CRITICAL risk"
            )
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class Decision:
    """The pragmatic outcome: what to do about a conclusion, risk-gated.

    Structural rule (the generic form of every future domain gate): if the
    conclusion is *not* inaction — i.e. this decision commits to doing
    something — the risk assessment must be acceptable. Choosing inaction
    is always permitted, whatever the risk verdict (CC §6: doing nothing is
    always reachable).
    """

    schema_version: ClassVar[int] = 1

    conclusion: Conclusion
    risk: RiskAssessment
    action: str
    standing_risks: tuple[IdentifiedRisk, ...] = field(default=())

    def __post_init__(self) -> None:
        """Enforce the act-only-on-acceptable-risk law."""
        if not self.action.strip():
            msg = "Decision.action must be non-empty (CC §11)"
            raise ValueError(msg)
        if not self.conclusion.is_inaction and not self.risk.acceptable:
            msg = (
                "a Decision cannot commit to action over an unacceptable "
                "RiskAssessment — the risk gate is structural, not advisory "
                "(Core Architecture §8, generalized)"
            )
            raise ValueError(msg)
