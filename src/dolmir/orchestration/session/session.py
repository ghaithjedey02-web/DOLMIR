"""ReasoningSession: the single orchestration entry point for a run.

A ``ReasoningSession`` is the seam a delivery adapter (Phase 2B's CLI, a
future API) calls to reason once. It composes three already-frozen pieces
so that callers never re-wire them by hand:

1. the ``GraphExecutor`` runs the assembled reasoning graph;
2. the completed ``ReasoningTrace`` is persisted through the injected
   repository port — *every* execution generates and stores a complete
   trace, success or abort (Standing Rule 6, EC §9 audit trail);
3. the trader-legible ``Explanation`` is rendered from the finished trace
   (CC §11), and the outcome is packaged into an immutable
   ``CognitiveState``.

All collaborators are injected (CA §19): no globals, no service locator,
no framework magic. The session holds no per-run mutable state itself, so
one instance safely serves many runs.
"""

from __future__ import annotations

from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.executor import ExecutionResult, GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.session.state import CognitiveState
from dolmir.orchestration.trace.decision import Decision
from dolmir.orchestration.trace.explanation import Explanation, build_explanation
from dolmir.orchestration.trace.record import RunStatus
from dolmir.orchestration.trace.repository import ReasoningTraceRepositoryPort

__all__ = ["ReasoningSession"]


class ReasoningSession:
    """Runs a reasoning graph, persists its trace, and returns the outcome."""

    def __init__(
        self,
        *,
        executor: GraphExecutor,
        trace_repository: ReasoningTraceRepositoryPort,
    ) -> None:
        """Inject the run executor and the trace store (constructor injection)."""
        self._executor = executor
        self._trace_repository = trace_repository

    async def run(self, graph: ReasoningGraph, *, seeds: tuple[object, ...]) -> CognitiveState:
        """Execute ``graph``, persist its trace, and return a ``CognitiveState``.

        Args:
            graph: A validated reasoning graph (assembled once, reusable).
            seeds: The run's external input artifacts; their exact types
                must match ``graph.seed_types`` (the executor enforces this).

        Returns:
            The immutable outcome snapshot — trace, conclusion, decision,
            and explanation.
        """
        result = await self._executor.execute(graph, seeds=seeds)
        await self._trace_repository.save(result.trace)

        return CognitiveState(
            trace=result.trace,
            conclusion=result.conclusion,
            decision=self._decision_of(result.context),
            explanation=self._explanation_of(result),
        )

    @staticmethod
    def _decision_of(context: GraphContext) -> Decision | None:
        """The run's ``Decision``, if its graph included a decision stage."""
        return context.get(Decision) if context.has(Decision) else None

    @staticmethod
    def _explanation_of(result: ExecutionResult) -> Explanation | None:
        """Render the explanation for a completed run; ``None`` if aborted.

        A completed run always carries a conclusion (guaranteed by the
        trace's own status invariant), so the explanation is well-defined
        exactly when the run completed.
        """
        if result.trace.status is not RunStatus.COMPLETED or result.conclusion is None:
            return None
        return build_explanation(result.trace, result.conclusion, result.context.opinions())
