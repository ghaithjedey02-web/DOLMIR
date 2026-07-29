"""SQLite trace persistence and the round-trip through the deserializer."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.trace.challenge import Challenge, ChallengeSeverity
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.deserialization import TraceDocumentError, trace_from_document
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import Hypothesis
from dolmir.orchestration.trace.record import ReasoningTrace, RunStatus, StepStatus, TraceStep
from dolmir.orchestration.trace.sqlite_repository import SqliteReasoningTraceRepository
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind

_MOMENT = datetime(2026, 7, 29, 13, 0, tzinfo=UTC)


def _id(tag: int) -> EntityId:
    return EntityId(uuid.UUID(int=tag))


def _rich_trace() -> ReasoningTrace:
    """A completed trace exercising every branch of the deserializer."""
    chosen = Hypothesis(
        hypothesis_id=_id(1),
        statement="go long the demand order block",
        falsification_condition="15m close below 1.0820",
    )
    conclusion = Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.HIGH, basis="two supports"
        ),
        rationale="clean 3R long with only a minor objection",
        standing_challenges=(
            Challenge(
                hypothesis_id=chosen.hypothesis_id,
                objection="HTF could be bearish",
                severity=ChallengeSeverity.MATERIAL,
                evidence=(
                    Evidence(
                        kind=EvidenceKind.CITATION,
                        source_ref="doctrine:htf@v1",
                        content="respect the higher timeframe",
                    ),
                ),
            ),
        ),
        open_uncertainties=(
            Uncertainty(
                kind=UncertaintyKind.EPISTEMIC,
                description="a news print lands in ten minutes",
                resolution="wait for the release",
            ),
        ),
    )
    steps = (
        TraceStep(
            node_name="perception",
            status=StepStatus.COMPLETED,
            started_at=_MOMENT,
            completed_at=_MOMENT,
            produced=("ObservationSet",),
            summary="transcribed 3 observation(s)",
        ),
        TraceStep(
            node_name="context",
            status=StepStatus.FAILED,
            started_at=_MOMENT,
            completed_at=_MOMENT,
            failure=NodeFailure(
                node_name="context", kind=FailureKind.TIMEOUT, message="retrieval timed out"
            ),
        ),
        TraceStep(
            node_name="world_model",
            status=StepStatus.SKIPPED,
            started_at=_MOMENT,
            completed_at=_MOMENT,
            skip_reason="required artifact(s) never produced: AssembledContext",
        ),
    )
    return ReasoningTrace(
        trace_id=_id(99),
        started_at=_MOMENT,
        completed_at=_MOMENT,
        status=RunStatus.COMPLETED,
        seeded=("ChartImage",),
        steps=steps,
        conclusion=conclusion,
    )


@pytest.fixture
def repository() -> SqliteReasoningTraceRepository:
    return SqliteReasoningTraceRepository.in_memory()


async def test_trace_round_trips_through_sqlite(
    repository: SqliteReasoningTraceRepository,
) -> None:
    trace = _rich_trace()

    await repository.save(trace)
    reconstructed = await repository.get(trace.trace_id)

    # Value equality across the whole frozen tree proves the deserializer is
    # the faithful inverse of the serializer.
    assert reconstructed == trace


async def test_unknown_trace_returns_none(
    repository: SqliteReasoningTraceRepository,
) -> None:
    assert await repository.get(_id(1234)) is None


async def test_traces_are_immutable_no_overwrite(
    repository: SqliteReasoningTraceRepository,
) -> None:
    trace = _rich_trace()
    await repository.save(trace)
    with pytest.raises(ValueError, match="immutable"):
        await repository.save(trace)


async def test_aborted_trace_round_trips(
    repository: SqliteReasoningTraceRepository,
) -> None:
    aborted = ReasoningTrace(
        trace_id=_id(7),
        started_at=_MOMENT,
        completed_at=_MOMENT,
        status=RunStatus.ABORTED,
        seeded=("ChartImage",),
        steps=(
            TraceStep(
                node_name="hypothesis_generation",
                status=StepStatus.FAILED,
                started_at=_MOMENT,
                completed_at=_MOMENT,
                failure=NodeFailure(
                    node_name="hypothesis_generation",
                    kind=FailureKind.EXTERNAL_ERROR,
                    message="model returned no scenarios",
                ),
            ),
        ),
        conclusion=None,
    )

    await repository.save(aborted)
    assert await repository.get(aborted.trace_id) == aborted


def test_deserializer_rejects_a_malformed_document() -> None:
    with pytest.raises(TraceDocumentError):
        trace_from_document({"trace_id": 123, "status": "completed"})
