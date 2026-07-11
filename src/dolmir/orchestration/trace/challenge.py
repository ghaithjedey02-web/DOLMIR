"""Falsification artifacts: structured attempts to prove hypotheses wrong.

Cognitive Constitution §9: adversarial falsification is a mandatory
pipeline stage, not a personality trait in a prompt. The
``FalsificationReport`` is that stage's typed product — and it must attest
coverage of every hypothesis in the set, so "we only stress-tested the
ones we liked" is unrepresentable.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Evidence
from dolmir.orchestration.trace.hypothesis import HypothesisSet

__all__ = ["Challenge", "ChallengeSeverity", "FalsificationReport"]


class ChallengeSeverity(enum.Enum):
    """How damaging a challenge is if it stands, in increasing order."""

    MINOR = "minor"
    """Worth recording; does not materially weaken the hypothesis."""

    MATERIAL = "material"
    """Weakens the hypothesis; caps its confidence at MODERATE."""

    SEVERE = "severe"
    """Undermines the hypothesis; caps its confidence at LOW."""


@dataclass(frozen=True, kw_only=True, slots=True)
class Challenge:
    """One concrete objection raised against one hypothesis."""

    hypothesis_id: EntityId
    objection: str
    severity: ChallengeSeverity
    evidence: tuple[Evidence, ...] = field(default=())

    def __post_init__(self) -> None:
        """Reject empty objections."""
        if not self.objection.strip():
            msg = "Challenge.objection must be non-empty"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class FalsificationReport:
    """The falsification stage's complete, coverage-attested output.

    ``examined_hypothesis_ids`` must equal the full hypothesis set —
    verified via :meth:`for_hypotheses` at construction. Finding no
    challenge against a hypothesis is a legitimate result; not *examining*
    it is not (CC §9).
    """

    examined_hypothesis_ids: frozenset[EntityId]
    challenges: tuple[Challenge, ...] = field(default=())

    def __post_init__(self) -> None:
        """Reject challenges against hypotheses the report claims not to have examined."""
        for challenge in self.challenges:
            if challenge.hypothesis_id not in self.examined_hypothesis_ids:
                msg = (
                    f"challenge targets hypothesis {challenge.hypothesis_id} "
                    "which the report does not attest examining"
                )
                raise ValueError(msg)

    @classmethod
    def for_hypotheses(
        cls, hypotheses: HypothesisSet, challenges: tuple[Challenge, ...]
    ) -> FalsificationReport:
        """Build a report attesting full coverage of ``hypotheses``.

        Raises:
            ValueError: If any challenge targets an id outside the set.
        """
        report = cls(examined_hypothesis_ids=hypotheses.ids(), challenges=challenges)
        return report

    def challenges_against(self, hypothesis_id: EntityId) -> tuple[Challenge, ...]:
        """All challenges raised against ``hypothesis_id``."""
        return tuple(
            challenge for challenge in self.challenges if challenge.hypothesis_id == hypothesis_id
        )

    def covers(self, hypotheses: HypothesisSet) -> bool:
        """Whether this report examined every member of ``hypotheses``."""
        return hypotheses.ids() <= self.examined_hypothesis_ids
