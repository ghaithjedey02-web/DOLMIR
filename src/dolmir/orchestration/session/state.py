"""CognitiveState: the immutable snapshot of one completed reasoning run.

Where ``GraphContext`` is the *live* working memory a run mutates as it
executes (CogA §11), ``CognitiveState`` is the *frozen* outcome the run
leaves behind: the complete trace, the conclusion it reached (if any), the
risk-gated decision it committed to (if any), and the trader-legible
explanation. It is what a caller keeps, persists, or hands to the next
stage of the system — never mutated after the run ends.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.decision import Decision
from dolmir.orchestration.trace.explanation import Explanation
from dolmir.orchestration.trace.record import ReasoningTrace, RunStatus

__all__ = ["CognitiveState"]


@dataclass(frozen=True, kw_only=True, slots=True)
class CognitiveState:
    """The immutable result of a reasoning run.

    Invariants (enforced at construction):

    - a *completed* run carries a ``conclusion`` and an ``explanation``;
      an *aborted* run carries neither (mirroring ``ReasoningTrace``'s own
      status rule — the snapshot cannot claim an outcome the trace denies);
    - ``decision`` is present only when the run's graph included a decision
      stage; it is always ``None`` for an aborted run.
    """

    schema_version: ClassVar[int] = 1

    trace: ReasoningTrace
    conclusion: Conclusion | None
    decision: Decision | None
    explanation: Explanation | None

    def __post_init__(self) -> None:
        """Keep the snapshot coherent with the trace's terminal status."""
        completed = self.trace.status is RunStatus.COMPLETED
        if completed and self.conclusion is None:
            msg = "a completed run's CognitiveState must carry its Conclusion"
            raise ValueError(msg)
        if not completed and self.conclusion is not None:
            msg = "an aborted run's CognitiveState cannot carry a Conclusion"
            raise ValueError(msg)
        if not completed and self.decision is not None:
            msg = "an aborted run's CognitiveState cannot carry a Decision"
            raise ValueError(msg)
        if completed and self.explanation is None:
            msg = "a completed run's CognitiveState must carry its Explanation"
            raise ValueError(msg)
        if not completed and self.explanation is not None:
            msg = "an aborted run's CognitiveState cannot carry an Explanation"
            raise ValueError(msg)

    @property
    def trace_id(self) -> EntityId:
        """The run's correlation identity (shared with its trace and logs)."""
        return self.trace.trace_id

    @property
    def concluded(self) -> bool:
        """Whether the run reached a conclusion."""
        return self.conclusion is not None

    @property
    def acted(self) -> bool:
        """Whether the run committed to a non-inaction decision."""
        return self.decision is not None and not self.decision.conclusion.is_inaction
