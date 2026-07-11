"""The serializability contract: every reasoning object renders to JSON."""

import json
from datetime import datetime, timedelta

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.trace.belief import Belief, WorldModel
from dolmir.orchestration.trace.challenge import Challenge, ChallengeSeverity
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.decision import (
    Decision,
    IdentifiedRisk,
    RiskAssessment,
    RiskMagnitude,
)
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus, Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.observation import Interpretation, Observation, ObservationSet
from dolmir.orchestration.trace.record import (
    ReasoningTrace,
    RunStatus,
    StepStatus,
    TraceStep,
)
from dolmir.orchestration.trace.reflection import LearningSignal, LearningSignalKind, Reflection
from dolmir.orchestration.trace.serialization import to_document
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind


def _json_round_trips(obj: object) -> dict[str, object]:
    document = to_document(obj)
    text = json.dumps(document)  # raises if anything non-JSON slipped through
    loaded: dict[str, object] = json.loads(text)
    return loaded


def test_every_reasoning_object_serializes_to_json(
    moment: datetime, hypothesis_set: HypothesisSet
) -> None:
    observation = Observation(
        observation_id=EntityId.generate(),
        source_ref="sensor:vibration-01",
        content="2x harmonic",
        observed_at=moment,
    )
    chosen = hypothesis_set.members[0]
    conclusion = Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.HIGH, basis="b"
        ),
        rationale="r",
        standing_challenges=(
            Challenge(
                hypothesis_id=chosen.hypothesis_id,
                objection="could be noise",
                severity=ChallengeSeverity.MINOR,
            ),
        ),
        open_uncertainties=(Uncertainty(kind=UncertaintyKind.ALEATORY, description="load noise"),),
    )
    belief = Belief(
        belief_id=EntityId.generate(),
        claim=Claim(statement="runs hot", status=EpistemicStatus.ASSUMPTION),
        formed_at=moment,
        derived_from=(EntityId.generate(),),
    )
    objects: tuple[object, ...] = (
        observation,
        ObservationSet(members=(observation,)),
        Interpretation(
            claims=(Claim(statement="wear-like", status=EpistemicStatus.ASSUMPTION),),
            interpreted_from=frozenset({observation.observation_id}),
        ),
        Evidence(kind=EvidenceKind.CITATION, source_ref="doc:1@v1", content="c"),
        hypothesis_set,
        conclusion,
        Decision(
            conclusion=conclusion,
            risk=RiskAssessment(
                risks=(
                    IdentifiedRisk(description="repair downtime", magnitude=RiskMagnitude.MODERATE),
                ),
                acceptable=True,
                basis="within maintenance budget",
            ),
            action="schedule replacement",
        ),
        Reflection(
            trace_id=EntityId.generate(),
            falsification_restatement=chosen.falsification_condition,
            implications="watch next reading",
        ),
        LearningSignal(
            trace_id=EntityId.generate(),
            kind=LearningSignalKind.PROCESS_QUALITY,
            statement="all evidence was considered",
        ),
        belief,
        WorldModel(
            model_id=EntityId.generate(), subject="machine-07", as_of=moment, beliefs=(belief,)
        ),
    )
    for obj in objects:
        document = _json_round_trips(obj)
        assert document["_type"] == type(obj).__name__


def test_full_trace_document_is_self_describing(moment: datetime) -> None:
    trace = ReasoningTrace(
        trace_id=EntityId.generate(),
        started_at=moment,
        completed_at=moment + timedelta(seconds=2),
        status=RunStatus.ABORTED,
        seeded=("ObservationSet",),
        steps=(
            TraceStep(
                node_name="interpretation",
                status=StepStatus.FAILED,
                started_at=moment,
                completed_at=moment,
                failure=NodeFailure(
                    node_name="interpretation",
                    kind=FailureKind.EXTERNAL_ERROR,
                    message="provider unreachable",
                ),
            ),
        ),
        conclusion=None,
    )
    document = _json_round_trips(trace)

    assert document["_type"] == "ReasoningTrace"
    assert document["schema_version"] == 1, "Standing Rule 6: version travels with the record"
    assert document["status"] == "aborted"
    steps = document["steps"]
    assert isinstance(steps, list)
    first_step = steps[0]
    assert isinstance(first_step, dict)
    failure = first_step["failure"]
    assert isinstance(failure, dict)
    assert failure["kind"] == "external_error"


def test_unknown_types_fail_loudly() -> None:
    class NotAReasoningObject:
        pass

    with pytest.raises(TypeError, match="cannot serialize"):
        to_document(NotAReasoningObject())


def test_frozensets_serialize_deterministically(moment: datetime) -> None:
    ids = frozenset({EntityId.generate() for _ in range(5)})
    interpretation = Interpretation(
        claims=(Claim(statement="s", status=EpistemicStatus.ASSUMPTION),),
        interpreted_from=ids,
    )
    first = json.dumps(to_document(interpretation))
    second = json.dumps(to_document(interpretation))
    assert first == second
