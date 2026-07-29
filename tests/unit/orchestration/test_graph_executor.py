import asyncio
from dataclasses import dataclass
from datetime import timedelta

import pytest

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.failure import FailureKind, FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.record import RunStatus, StepStatus


@dataclass(frozen=True)
class Alpha:
    value: int = 1


@dataclass(frozen=True)
class Beta:
    value: int = 2


class ScriptedNode:
    """Configurable node: produces artifacts, fails, hangs, or raises."""

    def __init__(
        self,
        name: str,
        *,
        requires: frozenset[type[object]] = frozenset(),
        produces: frozenset[type[object]] = frozenset(),
        artifacts: tuple[object, ...] = (),
        policy: FailurePolicy = FailurePolicy.ABORT_RUN,
        fail: bool = False,
        raise_exception: bool = False,
        hang_seconds: float = 0.0,
    ) -> None:
        self._name = name
        self._requires = requires
        self._produces = produces
        self._artifacts = artifacts
        self._policy = policy
        self._fail = fail
        self._raise = raise_exception
        self._hang = hang_seconds
        self.ran = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def requires(self) -> frozenset[type[object]]:
        return self._requires

    @property
    def produces(self) -> frozenset[type[object]]:
        return self._produces

    @property
    def failure_policy(self) -> FailurePolicy:
        return self._policy

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        self.ran = True
        if self._hang:
            await asyncio.sleep(self._hang)
        if self._raise:
            msg = "boom"
            raise RuntimeError(msg)
        if self._fail:
            return Err(
                NodeFailure(
                    node_name=self._name,
                    kind=FailureKind.EXTERNAL_ERROR,
                    message="scripted failure",
                )
            )
        return Ok(NodeReport(artifacts=self._artifacts, summary=f"{self._name} done"))


def _executor(clock: FixedClock, timeout: timedelta | None = None) -> GraphExecutor:
    return GraphExecutor(clock=clock, node_timeout=timeout)


async def test_linear_dataflow_produces_and_records(clock: FixedClock) -> None:
    producer = ScriptedNode("producer", produces=frozenset({Alpha}), artifacts=(Alpha(),))
    consumer = ScriptedNode(
        "consumer",
        requires=frozenset({Alpha}),
        produces=frozenset({Beta}),
        artifacts=(Beta(),),
    )
    result = await _executor(clock).execute(ReasoningGraph((consumer, producer)), seeds=())

    assert result.context.get(Beta) == Beta()
    assert result.trace.step("producer").status is StepStatus.COMPLETED
    assert result.trace.step("producer").produced == ("Alpha",)
    assert result.trace.status is RunStatus.ABORTED  # no Conclusion in this partial graph


async def test_seed_mismatch_is_a_wiring_error(clock: FixedClock) -> None:
    graph = ReasoningGraph(
        (ScriptedNode("n", requires=frozenset({Alpha})),), seed_types=frozenset({Alpha})
    )
    with pytest.raises(ValueError, match="do not match"):
        await _executor(clock).execute(graph, seeds=(Beta(),))


async def test_abort_policy_stops_later_waves(clock: FixedClock) -> None:
    failing = ScriptedNode(
        "failing", produces=frozenset({Alpha}), fail=True, policy=FailurePolicy.ABORT_RUN
    )
    downstream = ScriptedNode("downstream", requires=frozenset({Alpha}))
    result = await _executor(clock).execute(ReasoningGraph((failing, downstream)), seeds=())

    assert result.trace.status is RunStatus.ABORTED
    failed_step = result.trace.step("failing")
    assert failed_step.status is StepStatus.FAILED
    assert failed_step.failure is not None
    assert failed_step.failure.kind is FailureKind.EXTERNAL_ERROR
    assert not downstream.ran
    with pytest.raises(KeyError):
        result.trace.step("downstream")


async def test_continue_policy_degrades_and_dependents_skip(clock: FixedClock) -> None:
    optional = ScriptedNode(
        "optional", produces=frozenset({Alpha}), fail=True, policy=FailurePolicy.CONTINUE
    )
    dependent = ScriptedNode("dependent", requires=frozenset({Alpha}))
    independent = ScriptedNode("independent", produces=frozenset({Beta}), artifacts=(Beta(),))

    result = await _executor(clock).execute(
        ReasoningGraph((optional, dependent, independent)), seeds=()
    )

    assert result.trace.step("optional").status is StepStatus.FAILED
    skipped = result.trace.step("dependent")
    assert skipped.status is StepStatus.SKIPPED
    assert skipped.skip_reason is not None
    assert "Alpha" in skipped.skip_reason
    assert result.trace.step("independent").status is StepStatus.COMPLETED


async def test_unexpected_exception_becomes_typed_failure(clock: FixedClock) -> None:
    exploding = ScriptedNode("exploding", raise_exception=True, policy=FailurePolicy.CONTINUE)
    sibling = ScriptedNode("sibling", produces=frozenset({Beta}), artifacts=(Beta(),))
    result = await _executor(clock).execute(ReasoningGraph((exploding, sibling)), seeds=())

    step = result.trace.step("exploding")
    assert step.status is StepStatus.FAILED
    assert step.failure is not None
    assert step.failure.kind is FailureKind.UNEXPECTED
    assert "boom" in step.failure.message
    assert result.trace.step("sibling").status is StepStatus.COMPLETED


async def test_timeout_becomes_typed_failure(clock: FixedClock) -> None:
    slow = ScriptedNode("slow", hang_seconds=0.2, policy=FailurePolicy.CONTINUE)
    result = await _executor(clock, timeout=timedelta(milliseconds=10)).execute(
        ReasoningGraph((slow,)), seeds=()
    )
    step = result.trace.step("slow")
    assert step.status is StepStatus.FAILED
    assert step.failure is not None
    assert step.failure.kind is FailureKind.TIMEOUT


async def test_contract_violation_undeclared_artifact(clock: FixedClock) -> None:
    liar = ScriptedNode(
        "liar",
        produces=frozenset({Alpha}),
        artifacts=(Alpha(), Beta()),  # Beta is undeclared
        policy=FailurePolicy.CONTINUE,
    )
    result = await _executor(clock).execute(ReasoningGraph((liar,)), seeds=())

    step = result.trace.step("liar")
    assert step.status is StepStatus.FAILED
    assert step.failure is not None
    assert step.failure.kind is FailureKind.CONTRACT_VIOLATION
    assert "undeclared" in step.failure.message


async def test_contract_violation_missing_declared_artifact(clock: FixedClock) -> None:
    welcher = ScriptedNode(
        "welcher", produces=frozenset({Alpha}), artifacts=(), policy=FailurePolicy.CONTINUE
    )
    result = await _executor(clock).execute(ReasoningGraph((welcher,)), seeds=())

    step = result.trace.step("welcher")
    assert step.status is StepStatus.FAILED
    assert step.failure is not None
    assert "did not produce" in step.failure.message


async def test_parallel_wave_runs_all_independents(clock: FixedClock) -> None:
    nodes = tuple(
        ScriptedNode(f"n{i}", produces=frozenset(), policy=FailurePolicy.CONTINUE) for i in range(4)
    )
    result = await _executor(clock).execute(ReasoningGraph(nodes), seeds=())
    assert all(node.ran for node in nodes)
    statuses = {step.node_name: step.status for step in result.trace.steps}
    assert all(status is StepStatus.COMPLETED for status in statuses.values())


async def test_seeds_are_recorded_and_available(clock: FixedClock) -> None:
    consumer = ScriptedNode("consumer", requires=frozenset({Alpha}))
    graph = ReasoningGraph((consumer,), seed_types=frozenset({Alpha}))
    result = await _executor(clock).execute(graph, seeds=(Alpha(value=9),))

    assert result.trace.seeded == ("Alpha",)
    assert result.context.get(Alpha).value == 9
    assert result.trace.step("consumer").status is StepStatus.COMPLETED
