"""The terminal reasoning artifact: a chosen hypothesis with its account.

Generic by design: a ``Conclusion`` is not a trade, a diagnosis, or a
verdict — it is the engine's answer plus everything needed to explain and
later grade it. Domain layers (Phase 2B onward) translate it into domain
decisions and apply their own gates (e.g. the trading Risk Gate).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from dolmir.orchestration.trace.challenge import Challenge
from dolmir.orchestration.trace.confidence import ConfidenceAssessment
from dolmir.orchestration.trace.hypothesis import Hypothesis

__all__ = ["Conclusion"]


@dataclass(frozen=True, kw_only=True, slots=True)
class Conclusion:
    """The outcome of one reasoning run.

    Carries the chosen hypothesis itself (not just an id) so the conclusion
    is self-contained for explanation and persistence; ``standing_challenges``
    are the unresolved objections against the choice, acknowledged rather
    than hidden (CC §11: dissent is part of the explanation).
    """

    chosen: Hypothesis
    confidence: ConfidenceAssessment
    rationale: str
    standing_challenges: tuple[Challenge, ...] = field(default=())

    def __post_init__(self) -> None:
        """Enforce coherence between the choice and its metadata."""
        if not self.rationale.strip():
            msg = "Conclusion.rationale must be non-empty (CC §11)"
            raise ValueError(msg)
        if self.confidence.hypothesis_id != self.chosen.hypothesis_id:
            msg = "Conclusion.confidence must assess the chosen hypothesis"
            raise ValueError(msg)
        for challenge in self.standing_challenges:
            if challenge.hypothesis_id != self.chosen.hypothesis_id:
                msg = (
                    "Conclusion.standing_challenges must target the chosen "
                    "hypothesis — challenges to rejected hypotheses live in "
                    "the trace, not the conclusion"
                )
                raise ValueError(msg)

    @property
    def is_inaction(self) -> bool:
        """Whether the run concluded that doing nothing is the right call."""
        return self.chosen.represents_inaction
