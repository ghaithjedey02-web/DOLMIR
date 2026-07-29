"""ReasoningSession + CognitiveState, and the full 12-stage fast loop.

The integration test drives the *complete* canonical pipeline (CogA §3,
Perception → Immediate Reflection) through a ``ReasoningSession`` in a
deliberately non-trading machine-fault domain — proving the reusable
execution framework runs end-to-end, persists its trace, and returns an
immutable outcome, with zero domain knowledge in the kernel.
"""

from dataclasses import dataclass
from datetime import datetime

import pytest

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId, Err, Ok, Result
from dolmir.orchestration.agents.chief_decision import DeterministicChiefDecision
from dolmir.orchestration.agents.stages import (
    ChiefDecisionNode,
    ConfidenceSynthesisNode,
    ContextBuildingNode,
    DecisionNode,
    DeliberationNode,
    FalsificationNode,
    HypothesisGenerationNode,
    InterpretationNode,
    PerceptionNode,
    ReflectionNode,
    RiskEvaluationNode,
    WorldModelUpdateNode,
)
from dolmir.orchestration.failure import FailureKind, FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.session import CognitiveState, ReasoningSession
from dolmir.orchestration.trace.belief import Belief, WorldModel
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.context import AssembledContext
from dolmir.orchestration.trace.decision import (
    Decision,
    IdentifiedRisk,
    RiskAssessment,
    RiskMagnitude,
)
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus, Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.observation import (
    Interpretation,
    Observation,
    ObservationSet,
)
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance
from dolmir.orchestration.trace.record import ReasoningTrace, RunStatus, StepStatus
from dolmir.orchestration.trace.reflection import Reflection
from dolmir.orchestration.trace.repository import InMemoryReasoningTraceRepository

# --------------------------------------------------------------------------
# A complete non-trading pipeline: machine-fault diagnosis, all 12 stages.
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RawSensorFrame:
    """The seeded raw domain input — pre-perception."""

    vibration_2x_amplitude: float


class Perceive(PerceptionNode):
    def __init__(self, moment: datetime) -> None:
        super().__init__(extra_requires=frozenset({RawSensorFrame}))
        self._moment = moment

    @property
    def name(self) -> str:
        return "perception"

    async def perceive(self, context: GraphContext) -> Result[ObservationSet, NodeFailure]:
        frame = context.get(RawSensorFrame)
        return Ok(
            ObservationSet(
                members=(
                    Observation(
                        observation_id=EntityId.generate(),
                        source_ref="sensor:vibration-01",
                        content=f"2x amplitude {frame.vibration_2x_amplitude}",
                        observed_at=self._moment,
                    ),
                )
            )
        )


class Understand(InterpretationNode):
    async def interpret(self, context: GraphContext) -> Result[Interpretation, NodeFailure]:
        observations = context.get(ObservationSet)
        claim = Claim(
            statement="the spectrum resembles bearing wear", status=EpistemicStatus.ASSUMPTION
        )
        return Ok(Interpretation(claims=(claim,), interpreted_from=observations.ids()))


class BuildContext(ContextBuildingNode):
    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({Interpretation}))

    @property
    def name(self) -> str:
        return "context_building"

    async def build_context(self, context: GraphContext) -> Result[AssembledContext, NodeFailure]:
        doctrine = Claim(
            statement="2x harmonics indicate bearing wear (doctrine)",
            status=EpistemicStatus.FACT,
            evidence=(
                Evidence(
                    kind=EvidenceKind.CITATION,
                    source_ref="kb:vibration-analysis@v1",
                    content="2x harmonic ⇒ bearing wear",
                ),
            ),
        )
        return Ok(AssembledContext(items=(doctrine,)))


class UpdateWorldModel(WorldModelUpdateNode):
    def __init__(self, moment: datetime) -> None:
        super().__init__()
        self._moment = moment

    @property
    def name(self) -> str:
        return "world_model_update"

    async def update_world_model(self, context: GraphContext) -> Result[WorldModel, NodeFailure]:
        belief = Belief(
            belief_id=EntityId.generate(),
            claim=Claim(statement="unit runs warm under load", status=EpistemicStatus.ASSUMPTION),
            formed_at=self._moment,
            derived_from=(EntityId.generate(),),
        )
        return Ok(
            WorldModel(
                model_id=EntityId.generate(),
                subject="machine-07",
                as_of=self._moment,
                beliefs=(belief,),
            )
        )


class GenerateHypotheses(HypothesisGenerationNode):
    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({Interpretation, AssembledContext, WorldModel}))

    @property
    def name(self) -> str:
        return "hypothesis_generation"

    async def generate(self, context: GraphContext) -> Result[HypothesisSet, NodeFailure]:
        return Ok(
            HypothesisSet(
                members=(
                    Hypothesis(
                        hypothesis_id=EntityId.generate(),
                        statement="bearing wear",
                        falsification_condition="no 2x harmonic after replacement",
                    ),
                    Hypothesis(
                        hypothesis_id=EntityId.generate(),
                        statement="keep monitoring",
                        falsification_condition="a fault signature strengthens later",
                        represents_inaction=True,
                    ),
                )
            )
        )


class WearVoice(DeliberationNode):
    def __init__(self, role: str) -> None:
        super().__init__()
        self._role = role

    @property
    def name(self) -> str:
        return self._role

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        wear = context.get(HypothesisSet).members[0]
        return Ok(
            AgentOpinion(
                role=self._role,
                strategy_version="v1",
                assessments=(
                    HypothesisAssessment(
                        hypothesis_id=wear.hypothesis_id,
                        stance=Stance.SUPPORTS,
                        confidence=Confidence.HIGH,
                        reasoning="signature matches wear",
                        evidence=(
                            Evidence(
                                kind=EvidenceKind.OBSERVATION,
                                source_ref="sensor:vibration-01",
                                content="strong 2x peak",
                            ),
                        ),
                    ),
                ),
            )
        )


class NullFalsifier(FalsificationNode):
    async def falsify(self, context: GraphContext) -> Result[FalsificationReport, NodeFailure]:
        return Ok(FalsificationReport.for_hypotheses(context.get(HypothesisSet), ()))


class EvaluateRisk(RiskEvaluationNode):
    async def evaluate_risk(self, context: GraphContext) -> Result[RiskAssessment, NodeFailure]:
        return Ok(
            RiskAssessment(
                risks=(
                    IdentifiedRisk(description="repair downtime", magnitude=RiskMagnitude.MODERATE),
                ),
                acceptable=True,
                basis="within the maintenance window",
            )
        )


class CommitDecision(DecisionNode):
    async def decide(self, context: GraphContext) -> Result[Decision, NodeFailure]:
        conclusion = context.get(Conclusion)
        risk = context.get(RiskAssessment)
        action = "keep monitoring" if conclusion.is_inaction else "schedule bearing replacement"
        return Ok(Decision(conclusion=conclusion, risk=risk, action=action))


class LockInReflection(ReflectionNode):
    async def reflect(self, context: GraphContext) -> Result[Reflection, NodeFailure]:
        conclusion = context.get(Conclusion)
        return Ok(
            Reflection(
                trace_id=context.run_id,
                falsification_restatement=conclusion.chosen.falsification_condition,
                implications="revisit if the harmonic persists after replacement",
            )
        )


def _canonical_pipeline(moment: datetime) -> ReasoningGraph:
    return ReasoningGraph(
        (
            Perceive(moment),
            Understand(),
            BuildContext(),
            UpdateWorldModel(moment),
            GenerateHypotheses(),
            WearVoice("vibration_specialist"),
            WearVoice("thermal_specialist"),
            NullFalsifier(),
            ConfidenceSynthesisNode(),
            ChiefDecisionNode(DeterministicChiefDecision()),
            EvaluateRisk(),
            CommitDecision(),
            LockInReflection(),
        ),
        seed_types=frozenset({RawSensorFrame}),
    )


async def test_full_twelve_stage_pipeline_through_a_session(
    clock: FixedClock, moment: datetime
) -> None:
    repository = InMemoryReasoningTraceRepository()
    session = ReasoningSession(executor=GraphExecutor(clock=clock), trace_repository=repository)

    state = await session.run(
        _canonical_pipeline(moment), seeds=(RawSensorFrame(vibration_2x_amplitude=0.9),)
    )

    # A complete, concluded, acted-upon run.
    assert isinstance(state, CognitiveState)
    assert state.trace.status is RunStatus.COMPLETED
    assert state.concluded
    assert state.conclusion is not None
    assert state.conclusion.chosen.statement == "bearing wear"
    assert state.acted
    assert state.decision is not None
    assert state.decision.action == "schedule bearing replacement"

    # Every stage of the fast loop ran and completed, in the exact
    # dependency-derived order (waves in order; nodes name-sorted within a
    # wave). Reflection and risk_evaluation share a wave — both depend only
    # on the Conclusion — so reflection sorts first and decision runs last.
    step_names = [step.node_name for step in state.trace.steps]
    assert step_names == [
        "perception",
        "interpretation",
        "context_building",
        "world_model_update",
        "hypothesis_generation",
        "thermal_specialist",
        "vibration_specialist",
        "falsification",
        "confidence_synthesis",
        "chief_decision",
        "reflection",
        "risk_evaluation",
        "decision",
    ]
    assert all(step.status is StepStatus.COMPLETED for step in state.trace.steps)

    # The session persisted the complete trace.
    stored = await repository.get(state.trace_id)
    assert stored is not None
    assert stored.trace_id == state.trace_id

    # The explanation was rendered from the finished trace (stage 11).
    assert state.explanation is not None
    text = state.explanation.render_text()
    assert "bearing wear" in text
    assert "no 2x harmonic after replacement" in text


# --------------------------------------------------------------------------
# CognitiveState invariants.
# --------------------------------------------------------------------------


def _completed_trace(moment: datetime, conclusion: Conclusion) -> ReasoningTrace:
    return ReasoningTrace(
        trace_id=EntityId.generate(),
        started_at=moment,
        completed_at=moment,
        status=RunStatus.COMPLETED,
        seeded=(),
        steps=(),
        conclusion=conclusion,
    )


def _aborted_trace(moment: datetime) -> ReasoningTrace:
    return ReasoningTrace(
        trace_id=EntityId.generate(),
        started_at=moment,
        completed_at=moment,
        status=RunStatus.ABORTED,
        seeded=(),
        steps=(),
        conclusion=None,
    )


def _conclusion(hypothesis_set: HypothesisSet) -> Conclusion:
    chosen = hypothesis_set.members[0]
    return Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.HIGH, basis="b"
        ),
        rationale="r",
    )


def test_completed_state_requires_conclusion_and_explanation(
    moment: datetime, hypothesis_set: HypothesisSet
) -> None:
    trace = _completed_trace(moment, _conclusion(hypothesis_set))
    with pytest.raises(ValueError, match="must carry its Conclusion"):
        CognitiveState(trace=trace, conclusion=None, decision=None, explanation=None)


def test_aborted_state_forbids_conclusion(moment: datetime, hypothesis_set: HypothesisSet) -> None:
    trace = _aborted_trace(moment)
    with pytest.raises(ValueError, match="cannot carry a Conclusion"):
        CognitiveState(
            trace=trace,
            conclusion=_conclusion(hypothesis_set),
            decision=None,
            explanation=None,
        )


def test_aborted_state_is_valid_and_reports_not_concluded(moment: datetime) -> None:
    state = CognitiveState(
        trace=_aborted_trace(moment), conclusion=None, decision=None, explanation=None
    )
    assert not state.concluded
    assert not state.acted
    assert state.decision is None


# --------------------------------------------------------------------------
# Session persists the trace even on abort; stage bases fail as data.
# --------------------------------------------------------------------------


class FailingPerception(PerceptionNode):
    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({RawSensorFrame}))

    @property
    def name(self) -> str:
        return "perception"

    async def perceive(self, context: GraphContext) -> Result[ObservationSet, NodeFailure]:
        return Err(
            NodeFailure(
                node_name="perception",
                kind=FailureKind.EXTERNAL_ERROR,
                message="sensor bus offline",
            )
        )


async def test_session_persists_trace_and_returns_aborted_state_on_stage_failure(
    clock: FixedClock,
) -> None:
    repository = InMemoryReasoningTraceRepository()
    session = ReasoningSession(executor=GraphExecutor(clock=clock), trace_repository=repository)
    # Perception aborts (ABORT_RUN policy), so the run never concludes.
    graph = ReasoningGraph((FailingPerception(),), seed_types=frozenset({RawSensorFrame}))

    state = await session.run(graph, seeds=(RawSensorFrame(vibration_2x_amplitude=0.1),))

    assert state.trace.status is RunStatus.ABORTED
    assert not state.concluded
    assert state.conclusion is None
    assert state.decision is None
    assert state.explanation is None
    # The failed run's trace is still persisted — failed reasoning is auditable.
    assert await repository.get(state.trace_id) is not None
    assert state.trace.step("perception").status is StepStatus.FAILED


def test_new_stage_bases_declare_their_failure_policies(moment: datetime) -> None:
    # Load-bearing stages abort; enriching stages degrade explicitly.
    assert Perceive(moment).failure_policy is FailurePolicy.ABORT_RUN
    assert GenerateHypotheses().failure_policy is FailurePolicy.ABORT_RUN
    assert EvaluateRisk().failure_policy is FailurePolicy.ABORT_RUN
    assert CommitDecision().failure_policy is FailurePolicy.ABORT_RUN
    assert BuildContext().failure_policy is FailurePolicy.CONTINUE
    assert UpdateWorldModel(moment).failure_policy is FailurePolicy.CONTINUE
