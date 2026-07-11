"""Observations and interpretations: the pipeline's perception layer.

Cognitive Architecture §3 stages 1-2: an ``Observation`` is a faithful,
uninterpreted reading of the world; an ``Interpretation`` layers labeled
claims on top of observations, with provenance back to exactly which
observations it read. Interpretation never silently promotes itself to
fact — its claims carry epistemic status like every other claim (CC §8).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Claim

__all__ = ["Interpretation", "Observation", "ObservationSet"]


@dataclass(frozen=True, kw_only=True, slots=True)
class Observation:
    """One direct, low-inference reading of the world.

    ``source_ref`` names where the reading came from precisely enough to
    audit (a sensor id, a data feed, a document); ``observed_at`` is always
    timezone-aware and always injected — never read from a wall clock
    inside domain code (Standing Rule 7).
    """

    observation_id: EntityId
    source_ref: str
    content: str
    observed_at: datetime

    def __post_init__(self) -> None:
        """Reject untraceable or empty observations."""
        if not self.source_ref.strip():
            msg = "Observation.source_ref must be non-empty"
            raise ValueError(msg)
        if not self.content.strip():
            msg = "Observation.content must be non-empty"
            raise ValueError(msg)
        if self.observed_at.tzinfo is None:
            msg = "Observation.observed_at must be timezone-aware"
            raise ValueError(msg)


@dataclass(frozen=True, slots=True)
class ObservationSet:
    """The observations one reasoning run perceives, as a typed bundle."""

    members: tuple[Observation, ...]

    def __post_init__(self) -> None:
        """Reject empty or duplicate-id sets."""
        if not self.members:
            msg = "ObservationSet requires at least one observation"
            raise ValueError(msg)
        ids = [member.observation_id for member in self.members]
        if len(set(ids)) != len(ids):
            msg = "ObservationSet members must have unique observation ids"
            raise ValueError(msg)

    def ids(self) -> frozenset[EntityId]:
        """All member ids."""
        return frozenset(member.observation_id for member in self.members)


@dataclass(frozen=True, kw_only=True, slots=True)
class Interpretation:
    """Labeled claims derived from specific observations.

    Every claim keeps its own epistemic status (the structural grounding
    rules of ``Claim`` apply unchanged); ``interpreted_from`` records which
    observations this reading is based on, so the trace can answer "what
    data led you to say that?" (CC §11).
    """

    claims: tuple[Claim, ...]
    interpreted_from: frozenset[EntityId]

    def __post_init__(self) -> None:
        """Reject interpretations with no content or no provenance."""
        if not self.claims:
            msg = "Interpretation requires at least one claim"
            raise ValueError(msg)
        if not self.interpreted_from:
            msg = (
                "Interpretation.interpreted_from must reference at least one "
                "observation — an interpretation of nothing is a fabrication"
            )
            raise ValueError(msg)
