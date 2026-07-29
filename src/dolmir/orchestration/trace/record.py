"""The ReasoningTrace: the persisted, versioned record of one run.

The trace is domain data, not telemetry (Core Architecture §17): Memory
Engine will index it, the slow loop will grade it, and the explanation
pipeline renders it. It carries ``schema_version`` from the very first
record ever written (Standing Rule 6).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import ClassVar

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.failure import NodeFailure
from dolmir.orchestration.trace.conclusion import Conclusion

__all__ = ["ReasoningTrace", "RunStatus", "StepStatus", "TraceStep"]


class StepStatus(enum.Enum):
    """Terminal state of one node's execution within a run."""

    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    """Not executed because its required inputs never materialized —
    recorded, never silent (Cognitive Architecture §3)."""


class RunStatus(enum.Enum):
    """Terminal state of a whole reasoning run."""

    COMPLETED = "completed"
    ABORTED = "aborted"
    """The run did not reach a Conclusion — an aborting node failure, or
    the decision path degraded away (its inputs never materialized). The
    partial trace is still persisted: failed reasoning must be as
    auditable as successful reasoning."""


@dataclass(frozen=True, kw_only=True, slots=True)
class TraceStep:
    """One node's execution record.

    Exactly one of the outcome fields is populated, matching ``status``:
    ``produced`` for COMPLETED, ``failure`` for FAILED, ``skip_reason`` for
    SKIPPED — enforced at construction.
    """

    node_name: str
    status: StepStatus
    started_at: datetime
    completed_at: datetime
    produced: tuple[str, ...] = field(default=())
    summary: str = ""
    failure: NodeFailure | None = None
    skip_reason: str | None = None

    def __post_init__(self) -> None:
        """Enforce status/outcome coherence and aware timestamps."""
        if self.started_at.tzinfo is None or self.completed_at.tzinfo is None:
            msg = "TraceStep timestamps must be timezone-aware"
            raise ValueError(msg)
        if self.completed_at < self.started_at:
            msg = "TraceStep.completed_at precedes started_at"
            raise ValueError(msg)
        if self.status is StepStatus.FAILED and self.failure is None:
            msg = "a FAILED step must carry its NodeFailure"
            raise ValueError(msg)
        if self.status is not StepStatus.FAILED and self.failure is not None:
            msg = "only FAILED steps carry a NodeFailure"
            raise ValueError(msg)
        if self.status is StepStatus.SKIPPED and not (self.skip_reason or "").strip():
            msg = "a SKIPPED step must state why it was skipped"
            raise ValueError(msg)
        if self.status is not StepStatus.SKIPPED and self.skip_reason is not None:
            msg = "only SKIPPED steps carry a skip_reason"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class ReasoningTrace:
    """The complete, immutable record of one reasoning run.

    ``schema_version`` (Standing Rule 6) is bumped on any breaking change
    to this record's shape; persistence adapters store it alongside the
    payload so future upcasters can migrate years of history.
    """

    schema_version: ClassVar[int] = 1

    trace_id: EntityId
    started_at: datetime
    completed_at: datetime
    status: RunStatus
    seeded: tuple[str, ...]
    steps: tuple[TraceStep, ...]
    conclusion: Conclusion | None

    def __post_init__(self) -> None:
        """Enforce run-level coherence."""
        if self.started_at.tzinfo is None or self.completed_at.tzinfo is None:
            msg = "ReasoningTrace timestamps must be timezone-aware"
            raise ValueError(msg)
        if self.completed_at < self.started_at:
            msg = "ReasoningTrace.completed_at precedes started_at"
            raise ValueError(msg)
        if self.status is RunStatus.COMPLETED and self.conclusion is None:
            msg = "a COMPLETED run must carry a Conclusion"
            raise ValueError(msg)
        if self.status is RunStatus.ABORTED and self.conclusion is not None:
            msg = "an ABORTED run cannot carry a Conclusion"
            raise ValueError(msg)

    def step(self, node_name: str) -> TraceStep:
        """The step recorded for ``node_name``.

        Raises:
            KeyError: If no step exists for that node.
        """
        for entry in self.steps:
            if entry.node_name == node_name:
                return entry
        msg = f"no trace step for node {node_name!r}"
        raise KeyError(msg)
