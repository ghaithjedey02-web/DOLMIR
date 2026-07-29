"""Reasoning Graph execution: typed dataflow, waves, failure as data.

Rule (Standing Rule 3): data flows between nodes via typed artifacts and
the GraphContext — never via the Event Bus. Edges are derived from the
types nodes declare, not from nodes naming each other.
"""

from dolmir.orchestration.failure import FailureKind, FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import (
    DuplicateArtifactError,
    GraphContext,
    MissingArtifactError,
)
from dolmir.orchestration.graph.executor import ExecutionResult, GraphExecutor
from dolmir.orchestration.graph.graph import GraphValidationError, ReasoningGraph
from dolmir.orchestration.graph.node import GraphNode, NodeReport

__all__ = [
    "DuplicateArtifactError",
    "ExecutionResult",
    "FailureKind",
    "FailurePolicy",
    "GraphContext",
    "GraphExecutor",
    "GraphNode",
    "GraphValidationError",
    "MissingArtifactError",
    "NodeFailure",
    "NodeReport",
    "ReasoningGraph",
]
