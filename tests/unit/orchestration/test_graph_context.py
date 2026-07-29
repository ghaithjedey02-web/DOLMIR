from dataclasses import dataclass

import pytest

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.graph.context import (
    DuplicateArtifactError,
    GraphContext,
    MissingArtifactError,
)
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance


@dataclass(frozen=True)
class SensorBundle:
    readings: tuple[float, ...]


def _context(clock: FixedClock) -> GraphContext:
    return GraphContext(run_id=EntityId.generate(), clock=clock)


def test_typed_put_get_roundtrip(clock: FixedClock) -> None:
    context = _context(clock)
    bundle = SensorBundle(readings=(1.0, 2.0))
    context._store(bundle)

    assert context.get(SensorBundle) is bundle
    assert context.has(SensorBundle)


def test_missing_artifact_raises_named_error(clock: FixedClock) -> None:
    context = _context(clock)
    with pytest.raises(MissingArtifactError, match="SensorBundle"):
        context.get(SensorBundle)
    assert not context.has(SensorBundle)


def test_write_once_types_reject_duplicates(clock: FixedClock) -> None:
    context = _context(clock)
    context._store(SensorBundle(readings=(1.0,)))
    with pytest.raises(DuplicateArtifactError, match="write-once"):
        context._store(SensorBundle(readings=(2.0,)))


def test_opinions_accumulate_in_order(clock: FixedClock, hypothesis_set: HypothesisSet) -> None:
    context = _context(clock)
    target = hypothesis_set.members[0]

    def opinion(role: str) -> AgentOpinion:
        return AgentOpinion(
            role=role,
            strategy_version="v1",
            assessments=(
                HypothesisAssessment(
                    hypothesis_id=target.hypothesis_id,
                    stance=Stance.SUPPORTS,
                    confidence=Confidence.LOW,
                    reasoning="r",
                ),
            ),
        )

    first, second = opinion("first"), opinion("second")
    context._store(first)
    context._store(second)

    assert context.opinions() == (first, second)


def test_run_identity_and_clock_are_exposed(clock: FixedClock) -> None:
    run_id = EntityId.generate()
    context = GraphContext(run_id=run_id, clock=clock)
    assert context.run_id == run_id
    assert context.clock.now() == clock.now()
