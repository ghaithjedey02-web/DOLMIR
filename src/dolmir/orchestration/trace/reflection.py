"""Reflection and learning signals: the bridge between the two loops.

Cognitive Architecture §3 stage 12 / §4: a ``Reflection`` is written the
moment a run concludes, *before any outcome exists* — it locks in the
pre-registered falsification condition and names what is genuinely
uncertain, so the slow loop can later grade reality against a commitment,
never against a reconstructed memory (CC §4).

A ``LearningSignal`` is the slow loop's product — it can only exist once
an outcome has been observed. Only the *shapes* live here; the slow-loop
stages that produce them arrive in Phase 8 (Docs/ROADMAP.md), because
learning machinery without outcomes to learn from is busywork.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import ClassVar

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Evidence
from dolmir.orchestration.trace.uncertainty import Uncertainty

__all__ = ["LearningSignal", "LearningSignalKind", "Reflection"]


@dataclass(frozen=True, kw_only=True, slots=True)
class Reflection:
    """Pre-outcome self-assessment, locked in at decision time.

    ``falsification_restatement`` repeats the chosen hypothesis's
    pre-registered condition verbatim so the slow loop's outcome comparison
    has an immutable anchor (CC §4 — no post-hoc story-telling).
    """

    schema_version: ClassVar[int] = 1

    trace_id: EntityId
    falsification_restatement: str
    implications: str
    open_uncertainties: tuple[Uncertainty, ...] = field(default=())

    def __post_init__(self) -> None:
        """Reject reflections with nothing locked in or nothing said."""
        if not self.falsification_restatement.strip():
            msg = (
                "Reflection.falsification_restatement must be non-empty — "
                "the lock-in is the point (Cognitive Constitution §4)"
            )
            raise ValueError(msg)
        if not self.implications.strip():
            msg = "Reflection.implications must be non-empty"
            raise ValueError(msg)


class LearningSignalKind(enum.Enum):
    """What kind of lesson a learning signal carries."""

    PROCESS_QUALITY = "process_quality"
    """The reasoning was sound/unsound given what was knowable at decision
    time — graded independently of the outcome (CC §3)."""

    CALIBRATION = "calibration"
    """A stated confidence level did or did not match realized frequency
    (CC §5)."""

    BELIEF_REVISION = "belief_revision"
    """The outcome warrants revising a held belief (see ``belief.py``)."""


@dataclass(frozen=True, kw_only=True, slots=True)
class LearningSignal:
    """One lesson extracted by the slow loop, after an outcome exists.

    Belief updates driven by these signals are weighted by process
    quality, never by raw win/loss (CC §3) — that rule lives in the future
    slow-loop stages; this type is the evidence-carrying shape they emit.
    """

    schema_version: ClassVar[int] = 1

    trace_id: EntityId
    kind: LearningSignalKind
    statement: str
    evidence: tuple[Evidence, ...] = field(default=())

    def __post_init__(self) -> None:
        """Reject unexplained lessons."""
        if not self.statement.strip():
            msg = "LearningSignal.statement must be non-empty"
            raise ValueError(msg)
