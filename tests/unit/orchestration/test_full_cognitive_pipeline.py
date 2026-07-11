"""The complete cognitive pipeline, observation to reflection, non-trading.

Extends Phase 2A's exit-criterion proof with the perception front
(Observation → Interpretation) and the reflection tail — the full fast
loop of the Cognitive Architecture, in the machine-fault domain. Learning
(the slow loop) is deliberately absent: it requires outcomes, which
requires elapsed reality (Roadmap Phase 8).
"""

import json
from datetime import datetime

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId, Ok, Result
from dolmir.orchestration.agents.chief_decision import DeterministicChiefDecision
from dolmir.orchestration.agents.stages import (
    ChiefDecisionNode,
    ConfidenceSynthesisNode,
    DeliberationNode,
    FalsificationNode,
    InterpretationNode,
    ReflectionNode,
)
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.epistemic import (
    Claim,
    EpistemicStatus,
    Evidence,
    EvidenceKind,
)
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.observation import (
    Interpretation,
    Observation,
    ObservationSet,
)
from dolmir.orchestration.trace.opinion import (
    AgentOpinion,
    HypothesisAssessment,
    Stance,
)
from dolmir.orchestration.trace.record import RunStatus, StepStatus
from dolmir.orchestration.trace.reflection import Reflection
from dolmir.orchestration.trace.serialization import to_document
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind

MOMENT = datetime.fromisoformat("2026-07-09T12:00:00+00:00")


def _observations() -> ObservationSet:
    return ObservationSet(
        members=(
            Observation(
                observation_id=EntityId.generate(),
                source_ref="sensor:vibration-01",
                content="dominant peak at 2.02x shaft speed",
                observed_at=MOMENT,
            ),
        )
    )


class SignalInterpretation(InterpretationNode):
    """Labels the raw readings without promoting them to fact."""

    async def interpret(self, context: GraphContext) -> Result[Interpretation, NodeFailure]:
        observations = context.get(ObservationSet)
        claim = Claim(
            statement="the spectrum resembles a bearing-wear signature",
            status=EpistemicStatus.ASSUMPTION,
        )
        return Ok(Interpretation(claims=(claim,), interpreted_from=observations.ids()))


class ScenarioGeneration:
    """Turns the interpretation into the candidate hypothesis set."""

    @property
    def name(self) -> str:
        return "scenario_generation"

    @property
    def requires(self) -> frozenset[type[object]]:
        return frozenset({Interpretation})

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
                    statement="bearing wear",
                    falsification_condition="no 2x harmonic after bearing replacement",
                ),
                Hypothesis(
                    hypothesis_id=EntityId.generate(),
                    statement="insufficient signal; keep monitoring",
                    falsification_condition="a fault signature strengthens later",
                    represents_inaction=True,
                ),
            )
        )
        return Ok(NodeReport(artifacts=(hypotheses,), summary="2 scenarios"))


class WearSpecialist(DeliberationNode):
    """Single debate voice grounded in the interpretation's claims."""

    def __init__(self) -> None:
        super().__init__(extra_requires=frozenset({Interpretation}))

    @property
    def name(self) -> str:
        return "wear_specialist"

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        hypotheses = context.get(HypothesisSet)
        wear = hypotheses.members[0]
        return Ok(
            AgentOpinion(
                role=self.name,
                strategy_version="v1",
                assessments=(
                    HypothesisAssessment(
                        hypothesis_id=wear.hypothesis_id,
                        stance=Stance.SUPPORTS,
                        confidence=Confidence.HIGH,
                        reasoning="signature matches wear per the interpretation",
                        evidence=(
                            Evidence(
                                kind=EvidenceKind.OBSERVATION,
                                source_ref="sensor:vibration-01",
                                content="2.02x dominant peak",
                            ),
                        ),
                    ),
                ),
            )
        )


class NullFalsifier(FalsificationNode):
    """Examined everything, found no standing objection — a legitimate result."""

    async def falsify(self, context: GraphContext) -> Result[FalsificationReport, NodeFailure]:
        return Ok(FalsificationReport.for_hypotheses(context.get(HypothesisSet), ()))


class LockInReflection(ReflectionNode):
    """Locks in the falsification condition and names an open unknown."""

    async def reflect(self, context: GraphContext) -> Result[Reflection, NodeFailure]:
        conclusion = context.get(Conclusion)
        return Ok(
            Reflection(
                trace_id=context.run_id,
                falsification_restatement=conclusion.chosen.falsification_condition,
                implications="if replacement does not remove the harmonic, revisit alignment",
                open_uncertainties=(
                    Uncertainty(
                        kind=UncertaintyKind.EPISTEMIC,
                        description="alignment has not been measured",
                        resolution="laser alignment check",
                    ),
                ),
            )
        )


async def test_observation_to_reflection_pipeline(clock: FixedClock) -> None:
    graph = ReasoningGraph(
        (
            SignalInterpretation(),
            ScenarioGeneration(),
            WearSpecialist(),
            NullFalsifier(),
            ConfidenceSynthesisNode(),
            ChiefDecisionNode(DeterministicChiefDecision()),
            LockInReflection(),
        ),
        seed_types=frozenset({ObservationSet}),
    )

    result = await GraphExecutor(clock=clock).execute(graph, seeds=(_observations(),))

    assert result.trace.status is RunStatus.COMPLETED
    assert result.conclusion is not None
    assert result.conclusion.chosen.statement == "bearing wear"

    # Every stage of the fast loop ran, in dependency order.
    step_names = [step.node_name for step in result.trace.steps]
    assert step_names == [
        "interpretation",
        "scenario_generation",
        "wear_specialist",
        "falsification",
        "confidence_synthesis",
        "chief_decision",
        "reflection",
    ]
    assert all(step.status is StepStatus.COMPLETED for step in result.trace.steps)

    # The reflection locked in the pre-registered falsification condition
    # verbatim (CC §4) and named a reducible unknown.
    reflection = result.context.get(Reflection)
    assert reflection.falsification_restatement == result.conclusion.chosen.falsification_condition
    assert reflection.open_uncertainties[0].kind is UncertaintyKind.EPISTEMIC

    # The interpretation kept its epistemic honesty: an assumption, not a fact.
    interpretation = result.context.get(Interpretation)
    assert interpretation.claims[0].status is EpistemicStatus.ASSUMPTION

    # And the entire run serializes — trace and reflection alike.
    json.dumps(to_document(result.trace))
    json.dumps(to_document(reflection))
