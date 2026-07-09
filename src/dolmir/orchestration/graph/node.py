"""The GraphNode contract: typed dataflow, failure as data.

A node declares the artifact *types* it requires and produces; the graph
derives edges from those declarations (Core Architecture §8: "a node
depends on data types, not on which other node produced them"). Nodes
never publish to the Event Bus for intra-run handoff — Standing Rule 3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from dolmir.kernel.shared_kernel import Result
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext

__all__ = ["GraphNode", "NodeReport"]


@dataclass(frozen=True, kw_only=True, slots=True)
class NodeReport:
    """What one successful node execution produced.

    ``artifacts`` are handed to the executor, which stores them in the
    context and records their types in the trace — nodes never mutate the
    context directly. ``summary`` is one legible line for the trace's
    process view (CC §11).
    """

    artifacts: tuple[object, ...] = field(default=())
    summary: str = ""


@runtime_checkable
class GraphNode(Protocol):
    """One typed unit of reasoning work.

    Contract:

    - ``requires``: artifact types that must exist in the context before
      this node runs. The executor guarantees them (or skips the node,
      recording why, if an optional upstream producer failed).
    - ``produces``: artifact types this node's ``NodeReport`` will contain.
      Declaring a type and not producing it — or producing an undeclared
      type — is a contract violation the executor turns into a
      ``NodeFailure`` rather than letting it corrupt the run.
    - ``failure_policy``: what this node's failure means for the run.
    - ``run``: performs the work. Expected failures return ``Err``;
      raising is treated as ``FailureKind.UNEXPECTED`` and handled by
      policy — one node's bug never crashes sibling branches.
    """

    @property
    def name(self) -> str:
        """Unique, stable node name (appears in traces and explanations)."""
        ...

    @property
    def requires(self) -> frozenset[type[object]]:
        """Artifact types this node reads from the context."""
        ...

    @property
    def produces(self) -> frozenset[type[object]]:
        """Artifact types this node emits in its report."""
        ...

    @property
    def failure_policy(self) -> FailurePolicy:
        """Whether this node's failure aborts the run or degrades it."""
        ...

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Execute against the run's context and report what was produced."""
        ...
