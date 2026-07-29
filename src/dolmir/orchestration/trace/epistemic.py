"""Epistemic primitives: evidence, claims, and their status tags.

Cognitive Constitution §8: facts, observations, assumptions, and hypotheses
are never conflated — every claim in DOLMIR's reasoning carries an explicit
epistemic status, and nothing downstream reads a claim without knowing
which one it is.

Cognitive Constitution §2 (grounding discipline) is enforced *structurally*
here, not by convention: a ``Claim`` tagged ``FACT`` cannot be constructed
without at least one citation or computation grounding it. The reasoning
data model has no way to represent an ungrounded fact.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field

__all__ = ["Claim", "EpistemicStatus", "Evidence", "EvidenceKind"]


class EpistemicStatus(enum.Enum):
    """What kind of knowledge a claim represents (CC §8)."""

    FACT = "fact"
    """Grounded in cited doctrine or deterministic computation; not up for debate."""

    OBSERVATION = "observation"
    """A direct, low-inference reading of data."""

    ASSUMPTION = "assumption"
    """An interpretation layered on observations — labeled, never silently
    promoted to fact."""

    HYPOTHESIS = "hypothesis"
    """A forward-looking, inherently probabilistic claim."""


class EvidenceKind(enum.Enum):
    """Where a piece of evidence draws its authority from (CC §2)."""

    CITATION = "citation"
    """Retrieved from a curated source, referenced by stable id + version."""

    COMPUTATION = "computation"
    """Produced by a named deterministic computation over data in the system."""

    OBSERVATION = "observation"
    """A direct reading of input data available to this reasoning run."""


@dataclass(frozen=True, kw_only=True, slots=True)
class Evidence:
    """One grounded piece of support for a claim or stance.

    ``source_ref`` identifies the authority precisely enough to audit later:
    a document id + version for citations, a computation name for computed
    values, an input artifact reference for observations.
    """

    kind: EvidenceKind
    source_ref: str
    content: str

    def __post_init__(self) -> None:
        """Reject evidence that cannot be traced back to its source."""
        if not self.source_ref.strip():
            msg = "Evidence.source_ref must be non-empty — untraceable evidence is not evidence"
            raise ValueError(msg)
        if not self.content.strip():
            msg = "Evidence.content must be non-empty"
            raise ValueError(msg)


_FACT_GROUNDING_KINDS = frozenset({EvidenceKind.CITATION, EvidenceKind.COMPUTATION})


@dataclass(frozen=True, kw_only=True, slots=True)
class Claim:
    """A single statement with an explicit epistemic status and its grounding.

    Structural rules (all raise ``ValueError`` — the states are illegal, per
    Standing Rule 5):

    - ``FACT`` requires at least one ``CITATION`` or ``COMPUTATION`` evidence
      (CC §2: never asserted from parametric memory alone).
    - ``OBSERVATION`` requires at least one ``OBSERVATION`` evidence — a
      reading of data must point at the data it read.
    - ``ASSUMPTION`` and ``HYPOTHESIS`` may carry any evidence, including
      none: they are labeled interpretation, and the label is the point.
    """

    statement: str
    status: EpistemicStatus
    evidence: tuple[Evidence, ...] = field(default=())

    def __post_init__(self) -> None:
        """Enforce the grounding discipline for the declared status."""
        if not self.statement.strip():
            msg = "Claim.statement must be non-empty"
            raise ValueError(msg)
        if self.status is EpistemicStatus.FACT and not any(
            item.kind in _FACT_GROUNDING_KINDS for item in self.evidence
        ):
            msg = (
                "a FACT claim requires at least one CITATION or COMPUTATION "
                "evidence (Cognitive Constitution §2) — downgrade it to "
                "ASSUMPTION if no such grounding exists"
            )
            raise ValueError(msg)
        if self.status is EpistemicStatus.OBSERVATION and not any(
            item.kind is EvidenceKind.OBSERVATION for item in self.evidence
        ):
            msg = (
                "an OBSERVATION claim requires at least one OBSERVATION "
                "evidence pointing at the data it read"
            )
            raise ValueError(msg)
