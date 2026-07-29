"""Node failure as data (Core Architecture §8).

With many independently-failing nodes, failure is the normal case, not the
exception path: every node returns ``Result[NodeReport, NodeFailure]``, a
missing contribution is information downstream stages see, and the trace
records it — never a silent gap.

Lives at the orchestration root because it is shared vocabulary between
the graph executor (which produces failures) and the trace record (which
persists them) — neither subpackage owns it.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

__all__ = ["FailureKind", "FailurePolicy", "NodeFailure"]


class FailureKind(enum.Enum):
    """Why a node failed — coarse enough to be stable across providers."""

    TIMEOUT = "timeout"
    EXTERNAL_ERROR = "external_error"
    """A dependency outside the process failed (provider, storage)."""
    CONTRACT_VIOLATION = "contract_violation"
    """The node produced something that violates its declared contract."""
    UNEXPECTED = "unexpected"
    """An unanticipated exception, captured and surfaced rather than raised
    through the run (Core Architecture §16: never fail silently — but a
    single node's bug must not crash sibling branches either)."""


class FailurePolicy(enum.Enum):
    """What a node's failure means for the run it belongs to."""

    ABORT_RUN = "abort_run"
    """This node is load-bearing: without it the run cannot reach an honest
    conclusion. The run stops and the partial trace records why."""

    CONTINUE = "continue"
    """The run degrades explicitly: the node's products stay absent,
    dependents are skipped with a recorded reason, and downstream stages
    see the gap (Cognitive Architecture §3: degrade explicitly, never
    silently)."""


@dataclass(frozen=True, kw_only=True, slots=True)
class NodeFailure:
    """A typed account of one node's failure."""

    node_name: str
    kind: FailureKind
    message: str

    def __post_init__(self) -> None:
        """Reject unexplained failures; the trace must be able to show them."""
        if not self.message.strip():
            msg = "NodeFailure.message must be non-empty"
            raise ValueError(msg)
