"""Agent opinions: typed stances on the shared hypothesis set.

Cognitive Architecture §3 stage 6: debate participants weigh in for or
against each hypothesis in the shared set — structurally a qualitative
update of specific scenarios' plausibility, never disconnected free-form
takes. Free-form text exists only *inside* structured fields (``reasoning``
content); the structure itself is always typed.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.epistemic import Claim, Evidence

__all__ = ["AgentOpinion", "HypothesisAssessment", "Stance"]


class Stance(enum.Enum):
    """An agent's position on one hypothesis."""

    SUPPORTS = "supports"
    OPPOSES = "opposes"
    ABSTAINS = "abstains"
    """No informative position — distinct from silence: an explicit,
    recorded 'I cannot judge this', which the trace preserves."""


@dataclass(frozen=True, kw_only=True, slots=True)
class HypothesisAssessment:
    """One agent's position on one hypothesis, with its grounds."""

    hypothesis_id: EntityId
    stance: Stance
    confidence: Confidence
    reasoning: str
    evidence: tuple[Evidence, ...] = field(default=())

    def __post_init__(self) -> None:
        """Reject unreasoned stances; the trace must be able to explain them."""
        if not self.reasoning.strip():
            msg = (
                "HypothesisAssessment.reasoning must be non-empty — an "
                "unexplained stance cannot appear in an explainable trace "
                "(Cognitive Constitution §11)"
            )
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class AgentOpinion:
    """One specialist's complete contribution to a debate.

    ``role`` identifies the specialist; ``strategy_version`` records which
    version of its prompt/strategy produced this opinion (Core Architecture
    §8 — versioned strategies are what make later A/B evaluation possible).
    ``claims`` carry the epistemically-tagged statements behind the
    assessments.
    """

    role: str
    strategy_version: str
    assessments: tuple[HypothesisAssessment, ...]
    claims: tuple[Claim, ...] = field(default=())

    def __post_init__(self) -> None:
        """Enforce identity and one-assessment-per-hypothesis."""
        if not self.role.strip():
            msg = "AgentOpinion.role must be non-empty"
            raise ValueError(msg)
        if not self.strategy_version.strip():
            msg = "AgentOpinion.strategy_version must be non-empty"
            raise ValueError(msg)
        if not self.assessments:
            msg = "AgentOpinion must assess at least one hypothesis"
            raise ValueError(msg)
        ids = [assessment.hypothesis_id for assessment in self.assessments]
        if len(set(ids)) != len(ids):
            msg = "AgentOpinion may assess each hypothesis at most once"
            raise ValueError(msg)

    def assessment_for(self, hypothesis_id: EntityId) -> HypothesisAssessment | None:
        """This opinion's assessment of ``hypothesis_id``, if it gave one."""
        for assessment in self.assessments:
            if assessment.hypothesis_id == hypothesis_id:
                return assessment
        return None
