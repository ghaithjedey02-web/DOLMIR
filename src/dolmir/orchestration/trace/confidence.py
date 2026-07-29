"""The confidence vocabulary: an earned, ordered scale — never fake decimals.

Cognitive Constitution §5: confidence is only as precise as the evidence
behind it. Until months of tracked calibration exist, DOLMIR speaks a
small ordered vocabulary. The deterministic synthesis that *produces*
these levels lives in ``dolmir.orchestration.trace.synthesis`` — it
consumes opinions, so it sits above this vocabulary in the module layering
(opinions themselves carry a ``Confidence``).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

from dolmir.kernel.shared_kernel import EntityId

__all__ = [
    "Confidence",
    "ConfidenceAssessment",
    "ConfidenceReport",
]


class Confidence(enum.IntEnum):
    """The ordered confidence vocabulary (CC §5).

    An ``IntEnum`` so levels compare and order naturally, but the values
    are ranks, not probabilities — a numeric probability is only earned
    once the calibration record (Phase 8) justifies it.
    """

    LOW = 1
    MODERATE = 2
    HIGH = 3
    VERY_HIGH = 4


@dataclass(frozen=True, kw_only=True, slots=True)
class ConfidenceAssessment:
    """The synthesized confidence in one hypothesis, with its stated basis.

    ``basis`` is the human-readable account of *why* this level and not
    another (CC §11: a Confidence explains itself) — support counts,
    opposition, caps applied by standing challenges.
    """

    hypothesis_id: EntityId
    level: Confidence
    basis: str

    def __post_init__(self) -> None:
        """Reject unexplained confidence — that is confidence theater."""
        if not self.basis.strip():
            msg = "ConfidenceAssessment.basis must be non-empty (CC §5/§11)"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class ConfidenceReport:
    """Synthesized confidence for every hypothesis in the set."""

    assessments: tuple[ConfidenceAssessment, ...]

    def __post_init__(self) -> None:
        """Reject duplicate per-hypothesis entries."""
        ids = [assessment.hypothesis_id for assessment in self.assessments]
        if len(set(ids)) != len(ids):
            msg = "ConfidenceReport may contain one assessment per hypothesis"
            raise ValueError(msg)

    def for_hypothesis(self, hypothesis_id: EntityId) -> ConfidenceAssessment:
        """The assessment for ``hypothesis_id``.

        Raises:
            KeyError: If the report has no entry for that id.
        """
        for assessment in self.assessments:
            if assessment.hypothesis_id == hypothesis_id:
                return assessment
        msg = f"no confidence assessment for hypothesis {hypothesis_id}"
        raise KeyError(msg)
