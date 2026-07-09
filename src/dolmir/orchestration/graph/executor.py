"""GraphExecutor: deterministic, wave-parallel execution with a full trace.

The executor owns all context mutation: nodes return their products, the
executor stores them and records every step — completed, failed, or
skipped — so the trace is a faithful account of the run (CC §11), not a
best-effort log.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta

import structlog

from dolmir.kernel.clock import ClockPort
from dolmir.kernel.shared_kernel import EntityId, Err, Ok, Result
from dolmir.orchestration.failure import FailureKind, FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import DuplicateArtifactError, GraphContext
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.graph.node import GraphNode, NodeReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.opinion import AgentOpinion
from dolmir.orchestration.trace.record import (
    ReasoningTrace,
    RunStatus,
    StepStatus,
    TraceStep,
)

__all__ = ["ExecutionResult", "GraphExecutor"]

_logger = structlog.get_logger(__name__)


@dataclass(frozen=True, kw_only=True, slots=True)
class ExecutionResult:
    """Everything one run yields.

    The trace, the conclusion (if reached), and the final context for
    callers that need produced artifacts.
    """

    trace: ReasoningTrace
    conclusion: Conclusion | None
    context: GraphContext


@dataclass(frozen=True, kw_only=True, slots=True)
class _NodeOutcome:
    """Internal: one node's raw result plus its timing."""

    node: GraphNode
    result: Result[NodeReport, NodeFailure]
    started_at: datetime
    completed_at: datetime


class GraphExecutor:
    """Executes a ``ReasoningGraph`` wave by wave.

    Within a wave, nodes run concurrently (``asyncio.gather``); their
    products are applied to the context *after* the wave completes, in
    node-name order, so context mutation is never concurrent and traces
    are deterministic given deterministic nodes.
    """

    def __init__(self, *, clock: ClockPort, node_timeout: timedelta | None = None) -> None:
        """Configure the executor.

        Args:
            clock: Injected time source for all trace timestamps
                (Standing Rule 7).
            node_timeout: Per-node wall-clock budget; ``None`` disables the
                budget. A breach becomes ``FailureKind.TIMEOUT`` handled by
                the node's failure policy — never an exception through the
                run.
        """
        self._clock = clock
        self._node_timeout = node_timeout

    async def execute(self, graph: ReasoningGraph, *, seeds: tuple[object, ...]) -> ExecutionResult:
        """Run ``graph`` against fresh context seeded with ``seeds``.

        Args:
            graph: A validated reasoning graph.
            seeds: External input artifacts; their exact types must match
                the graph's declared ``seed_types``.

        Returns:
            The completed (or aborted) run.

        Raises:
            ValueError: If ``seeds`` do not match ``graph.seed_types`` —
                a wiring error at the composition root, not a run outcome.
        """
        seed_types = {type(seed) for seed in seeds}
        if seed_types != set(graph.seed_types):
            msg = (
                f"seed artifacts {sorted(t.__name__ for t in seed_types)} do not "
                f"match the graph's declared seed types "
                f"{sorted(t.__name__ for t in graph.seed_types)}"
            )
            raise ValueError(msg)

        run_id = EntityId.generate()
        context = GraphContext(run_id=run_id, clock=self._clock)
        for seed in seeds:
            context._store(seed)

        log = _logger.bind(run_id=str(run_id))
        started_at = self._clock.now()
        steps: list[TraceStep] = []
        aborted = False

        for wave in graph.waves:
            runnable, skipped = self._partition_wave(wave, context)
            steps.extend(skipped)

            outcomes = await asyncio.gather(*(self._run_node(node, context) for node in runnable))
            for outcome in outcomes:
                step, abort_requested = self._apply_outcome(outcome, context, log)
                steps.append(step)
                aborted = aborted or abort_requested
            if aborted:
                break

        conclusion = context.get(Conclusion) if context.has(Conclusion) else None
        concluded_cleanly = conclusion is not None and not aborted
        status = RunStatus.COMPLETED if concluded_cleanly else RunStatus.ABORTED
        trace = ReasoningTrace(
            trace_id=run_id,
            started_at=started_at,
            completed_at=self._clock.now(),
            status=status,
            seeded=tuple(sorted(t.__name__ for t in graph.seed_types)),
            steps=tuple(steps),
            conclusion=conclusion if status is RunStatus.COMPLETED else None,
        )
        log.info(
            "reasoning run finished",
            status=status.value,
            steps=len(steps),
            concluded=conclusion is not None,
        )
        return ExecutionResult(trace=trace, conclusion=trace.conclusion, context=context)

    def _partition_wave(
        self, wave: tuple[GraphNode, ...], context: GraphContext
    ) -> tuple[list[GraphNode], list[TraceStep]]:
        """Split a wave into runnable nodes and skip records.

        A node whose required types are absent (an optional upstream
        producer failed or was itself skipped) is skipped with the missing
        types named — degradation is explicit, never silent (CogA §3).
        ``AgentOpinion`` requirements are satisfied by one or more
        accumulated opinions.
        """
        runnable: list[GraphNode] = []
        skipped: list[TraceStep] = []
        for node in wave:
            missing = sorted(
                required.__name__
                for required in node.requires
                if not (context.opinions() if required is AgentOpinion else context.has(required))
            )
            if missing:
                moment = self._clock.now()
                skipped.append(
                    TraceStep(
                        node_name=node.name,
                        status=StepStatus.SKIPPED,
                        started_at=moment,
                        completed_at=moment,
                        skip_reason=f"required artifact(s) never produced: {', '.join(missing)}",
                    )
                )
            else:
                runnable.append(node)
        return runnable, skipped

    async def _run_node(self, node: GraphNode, context: GraphContext) -> _NodeOutcome:
        """Run one node, converting every misbehavior into typed failure."""
        started_at = self._clock.now()
        result: Result[NodeReport, NodeFailure]
        try:
            if self._node_timeout is not None:
                async with asyncio.timeout(self._node_timeout.total_seconds()):
                    result = await node.run(context)
            else:
                result = await node.run(context)
        except TimeoutError:
            result = Err(
                NodeFailure(
                    node_name=node.name,
                    kind=FailureKind.TIMEOUT,
                    message=f"exceeded node budget of {self._node_timeout}",
                )
            )
        except Exception as exc:
            result = Err(
                NodeFailure(
                    node_name=node.name,
                    kind=FailureKind.UNEXPECTED,
                    message=f"{type(exc).__name__}: {exc}",
                )
            )
        return _NodeOutcome(
            node=node, result=result, started_at=started_at, completed_at=self._clock.now()
        )

    def _apply_outcome(
        self,
        outcome: _NodeOutcome,
        context: GraphContext,
        log: structlog.typing.FilteringBoundLogger,
    ) -> tuple[TraceStep, bool]:
        """Validate a node's report, store its products, build its step.

        Returns the trace step and whether the run must abort.
        """
        node = outcome.node
        match outcome.result:
            case Ok(report):
                violation = self._contract_violation(node, report)
                if violation is not None:
                    return self._failure_step(node, outcome, violation, log)
                try:
                    for artifact in report.artifacts:
                        context._store(artifact)
                except DuplicateArtifactError as exc:
                    failure = NodeFailure(
                        node_name=node.name,
                        kind=FailureKind.CONTRACT_VIOLATION,
                        message=str(exc),
                    )
                    return self._failure_step(node, outcome, failure, log)
                return (
                    TraceStep(
                        node_name=node.name,
                        status=StepStatus.COMPLETED,
                        started_at=outcome.started_at,
                        completed_at=outcome.completed_at,
                        produced=tuple(
                            sorted(type(artifact).__name__ for artifact in report.artifacts)
                        ),
                        summary=report.summary,
                    ),
                    False,
                )
            case Err(failure):
                return self._failure_step(node, outcome, failure, log)

    def _contract_violation(self, node: GraphNode, report: NodeReport) -> NodeFailure | None:
        """Check a report against the node's declared ``produces``."""
        produced_types = {type(artifact) for artifact in report.artifacts}
        undeclared = produced_types - set(node.produces)
        missing = set(node.produces) - produced_types
        if not undeclared and not missing:
            return None
        details: list[str] = []
        if undeclared:
            details.append(f"produced undeclared type(s): {sorted(t.__name__ for t in undeclared)}")
        if missing:
            details.append(f"declared but did not produce: {sorted(t.__name__ for t in missing)}")
        return NodeFailure(
            node_name=node.name,
            kind=FailureKind.CONTRACT_VIOLATION,
            message="; ".join(details),
        )

    def _failure_step(
        self,
        node: GraphNode,
        outcome: _NodeOutcome,
        failure: NodeFailure,
        log: structlog.typing.FilteringBoundLogger,
    ) -> tuple[TraceStep, bool]:
        """Record a failure and decide whether it aborts the run."""
        abort = node.failure_policy is FailurePolicy.ABORT_RUN
        log.error(
            "node failed",
            node=node.name,
            kind=failure.kind.value,
            message=failure.message,
            aborts_run=abort,
        )
        return (
            TraceStep(
                node_name=node.name,
                status=StepStatus.FAILED,
                started_at=outcome.started_at,
                completed_at=outcome.completed_at,
                failure=failure,
            ),
            abort,
        )
