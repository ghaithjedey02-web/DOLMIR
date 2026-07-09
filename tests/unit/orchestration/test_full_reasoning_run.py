"""End-to-end reasoning run in a NON-trading domain.

This is Phase 2A's exit-criterion test: the complete pipeline —
observations → hypotheses → parallel debate → falsification → confidence
synthesis → conclusion → explanation — executed against a machine-fault
diagnosis scenario. Nothing here mentions trading, which is the point:
the engine reasons; domains are just seeded artifacts and specialists.
"""

from dataclasses import dataclass

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId, Ok, Result
from dolmir.orchestration.agents.chief_decision import DeterministicChiefDecision
from dolmir.orchestration.agents.stages import (
    ChiefDecisionNode,
    ConfidenceSynthesisNode,
    DeliberationNode,
    FalsificationNode,
)
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.challenge import (
    Challenge,
    ChallengeSeverity,
    FalsificationReport,
)
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.explanation import build_explanation
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import (
    AgentOpinion,
    HypothesisAssessment,
    Stance,
)
from dolmir.orchestration.trace.record import RunStatus, StepStatus


@dataclass(frozen=True)
class SensorObservations:
    """The seeded domain input: raw readings from the machine."""

    vibration_at_2x: bool
    temperature_rising: bool


class HypothesisGenerationNode:
    """Domain node: turns observations into the candidate scenario set."""

    @property
    def name(self) -> str:
        return "hypothesis_generation"

    @property
    def requires(self) -> frozenset[type[object]]:
        return frozenset({SensorObservations})

    @property
    def produces(self) -> frozenset[type[object]]:
        return frozenset({HypothesisSet})

    @property
    def failure_policy(self) -> FailurePolicy:
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        hypotheses = HypothesisSet(
            members=(
                Hypothesis(
                    hypothesis_id=EntityId.generate(),
                    statement="bearing wear is causing the vibration",
                    falsification_condition="no 2x harmonic after bearing replacement",
                ),
                Hypothesis(
                    hypothesis_id=EntityId.generate(),
                    statement="shaft misalignment is causing the vibration",
                    falsification_condition="laser alignment reads within tolerance",
                ),
                Hypothesis(
                    hypothesis_id=EntityId.generate(),
                    statement="insufficient signal; keep monitoring",
                    falsification_condition="any fault signature strengthens in later readings",
                    represents_inaction=True,
                ),
            )
        )
        return Ok(NodeReport(artifacts=(hypotheses,), summary="3 candidate scenarios"))


class VibrationSpecialist(DeliberationNode):
    """Domain deliberator: reads sensors, supports the bearing hypothesis."""

    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({SensorObservations}))

    @property
    def name(self) -> str:
        return "vibration_specialist"

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        observations = context.get(SensorObservations)
        hypotheses = context.get(HypothesisSet)
        bearing = hypotheses.members[0]
        evidence = Evidence(
            kind=EvidenceKind.OBSERVATION,
            source_ref="sensor:vibration-01",
            content="strong 2x harmonic present"
            if observations.vibration_at_2x
            else "no 2x harmonic",
        )
        stance = Stance.SUPPORTS if observations.vibration_at_2x else Stance.OPPOSES
        return Ok(
            AgentOpinion(
                role=self.name,
                strategy_version="v1",
                assessments=(
                    HypothesisAssessment(
                        hypothesis_id=bearing.hypothesis_id,
                        stance=stance,
                        confidence=Confidence.HIGH,
                        reasoning="2x harmonics are the classic bearing-wear signature",
                        evidence=(evidence,),
                    ),
                ),
            )
        )


class ThermalSpecialist(DeliberationNode):
    """Second parallel voice: temperature corroborates mechanical wear."""

    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({SensorObservations}))

    @property
    def name(self) -> str:
        return "thermal_specialist"

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        observations = context.get(SensorObservations)
        hypotheses = context.get(HypothesisSet)
        bearing = hypotheses.members[0]
        stance = Stance.SUPPORTS if observations.temperature_rising else Stance.ABSTAINS
        return Ok(
            AgentOpinion(
                role=self.name,
                strategy_version="v1",
                assessments=(
                    HypothesisAssessment(
                        hypothesis_id=bearing.hypothesis_id,
                        stance=stance,
                        confidence=Confidence.MODERATE,
                        reasoning="rising temperature is consistent with friction from wear",
                        evidence=(
                            Evidence(
                                kind=EvidenceKind.OBSERVATION,
                                source_ref="sensor:thermal-04",
                                content="bearing housing +8C over baseline",
                            ),
                        ),
                    ),
                ),
            )
        )


class SystematicFalsifier(FalsificationNode):
    """Domain falsifier: raises a real objection against the leader."""

    async def falsify(self, context: GraphContext) -> Result[FalsificationReport, NodeFailure]:
        hypotheses = context.get(HypothesisSet)
        bearing = hypotheses.members[0]
        challenge = Challenge(
            hypothesis_id=bearing.hypothesis_id,
            objection="electrical interference can also produce 2x-like peaks",
            severity=ChallengeSeverity.MINOR,
        )
        return Ok(FalsificationReport.for_hypotheses(hypotheses, (challenge,)))


async def test_complete_reasoning_run_in_a_non_trading_domain(clock: FixedClock) -> None:
    graph = ReasoningGraph(
        (
            HypothesisGenerationNode(),
            VibrationSpecialist(),
            ThermalSpecialist(),
            SystematicFalsifier(),
            ConfidenceSynthesisNode(),
            ChiefDecisionNode(DeterministicChiefDecision()),
        ),
        seed_types=frozenset({SensorObservations}),
    )
    executor = GraphExecutor(clock=clock)

    result = await executor.execute(
        graph, seeds=(SensorObservations(vibration_at_2x=True, temperature_rising=True),)
    )

    # The run completed and concluded on the evidence-supported hypothesis.
    assert result.trace.status is RunStatus.COMPLETED
    assert result.conclusion is not None
    assert result.conclusion.chosen.statement == "bearing wear is causing the vibration"
    assert not result.conclusion.is_inaction

    # Debate ran as a parallel wave: both specialists in the same wave.
    wave_names = [tuple(node.name for node in wave) for wave in graph.waves]
    assert ("thermal_specialist", "vibration_specialist") in wave_names

    # Every stage is in the trace, in dependency order, all completed.
    step_names = [step.node_name for step in result.trace.steps]
    assert step_names == [
        "hypothesis_generation",
        "thermal_specialist",
        "vibration_specialist",
        "falsification",
        "confidence_synthesis",
        "chief_decision",
    ]
    assert all(step.status is StepStatus.COMPLETED for step in result.trace.steps)

    # The falsifier's standing challenge travelled into the conclusion.
    assert any(
        "electrical interference" in challenge.objection
        for challenge in result.conclusion.standing_challenges
    )

    # The explanation renders every constitutional section, legibly.
    explanation = build_explanation(result.trace, result.conclusion, result.context.opinions())
    text = explanation.render_text()
    assert "CONCLUSION" in text
    assert "bearing wear" in text
    assert "sensor:vibration-01" in text  # evidence is cited by source
    assert "THIS CONCLUSION IS WRONG IF" in text
    assert "no 2x harmonic after bearing replacement" in text  # pre-registered falsification
    assert "electrical interference" in text  # dissent is visible, not hidden
    assert "chief_decision" in text  # the process appendix names every stage


async def test_ambiguous_signal_concludes_inaction(clock: FixedClock) -> None:
    graph = ReasoningGraph(
        (
            HypothesisGenerationNode(),
            VibrationSpecialist(),
            ThermalSpecialist(),
            SystematicFalsifier(),
            ConfidenceSynthesisNode(),
            ChiefDecisionNode(DeterministicChiefDecision()),
        ),
        seed_types=frozenset({SensorObservations}),
    )
    executor = GraphExecutor(clock=clock)

    # No 2x harmonic: the vibration specialist opposes, thermal abstains.
    result = await executor.execute(
        graph, seeds=(SensorObservations(vibration_at_2x=False, temperature_rising=False),)
    )

    assert result.trace.status is RunStatus.COMPLETED
    assert result.conclusion is not None
    assert result.conclusion.is_inaction, (
        "with no supporting evidence the engine must be able to say 'not enough signal' (CC §6)"
    )
