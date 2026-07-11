from collections.abc import Callable
from datetime import datetime, timedelta

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.trace.hypothesis import Hypothesis
from dolmir.orchestration.trace.record import (
    ReasoningTrace,
    RunStatus,
    StepStatus,
    TraceStep,
)
from dolmir.orchestration.trace.repository import InMemoryReasoningTraceRepository

HypothesisFactory = Callable[..., Hypothesis]


def _step(moment: datetime, name: str = "node") -> TraceStep:
    return TraceStep(
        node_name=name,
        status=StepStatus.COMPLETED,
        started_at=moment,
        completed_at=moment,
        produced=("Alpha",),
    )


def _trace(moment: datetime, status: RunStatus = RunStatus.ABORTED) -> ReasoningTrace:
    return ReasoningTrace(
        trace_id=EntityId.generate(),
        started_at=moment,
        completed_at=moment + timedelta(seconds=1),
        status=status,
        seeded=("SensorBundle",),
        steps=(_step(moment),),
        conclusion=None,
    )


def test_schema_version_present_from_first_record(moment: datetime) -> None:
    assert ReasoningTrace.schema_version == 1
    assert type(_trace(moment)).schema_version == 1


def test_failed_step_must_carry_failure(moment: datetime) -> None:
    with pytest.raises(ValueError, match="must carry its NodeFailure"):
        TraceStep(node_name="n", status=StepStatus.FAILED, started_at=moment, completed_at=moment)
    with pytest.raises(ValueError, match="only FAILED steps"):
        TraceStep(
            node_name="n",
            status=StepStatus.COMPLETED,
            started_at=moment,
            completed_at=moment,
            failure=NodeFailure(node_name="n", kind=FailureKind.TIMEOUT, message="x"),
        )


def test_skipped_step_must_state_reason(moment: datetime) -> None:
    with pytest.raises(ValueError, match="must state why"):
        TraceStep(node_name="n", status=StepStatus.SKIPPED, started_at=moment, completed_at=moment)


def test_completed_run_requires_conclusion(moment: datetime) -> None:
    with pytest.raises(ValueError, match="must carry a Conclusion"):
        ReasoningTrace(
            trace_id=EntityId.generate(),
            started_at=moment,
            completed_at=moment,
            status=RunStatus.COMPLETED,
            seeded=(),
            steps=(),
            conclusion=None,
        )


def test_step_lookup(moment: datetime) -> None:
    trace = _trace(moment)
    assert trace.step("node").produced == ("Alpha",)
    with pytest.raises(KeyError):
        trace.step("ghost")


async def test_repository_round_trip_and_immutability(moment: datetime) -> None:
    repository = InMemoryReasoningTraceRepository()
    trace = _trace(moment)

    await repository.save(trace)
    assert await repository.get(trace.trace_id) == trace
    assert await repository.get(EntityId.generate()) is None
    with pytest.raises(ValueError, match="immutable"):
        await repository.save(trace)
