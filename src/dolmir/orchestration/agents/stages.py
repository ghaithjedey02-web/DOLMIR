"""Stage-node toolkit: the reusable shapes of the cognitive pipeline.

These base classes are how the Cognitive Architecture's stages become
graph nodes: subclasses supply the *judgment* (eventually LLM-backed, in
Phase 2B); the bases supply the *contract* — declared types, failure
policies, and report assembly. Debate needs no special mechanism: it is
simply several ``DeliberationNode`` subclasses in the same wave, whose
opinions accumulate in the context.
"""

from __future__ import annotations

import abc

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.agents.chief_decision import ChiefDecisionPort
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import ConfidenceReport
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.observation import Interpretation, ObservationSet
from dolmir.orchestration.trace.opinion import AgentOpinion
from dolmir.orchestration.trace.reflection import Reflection
from dolmir.orchestration.trace.synthesis import synthesize_confidence

__all__ = [
    "ChiefDecisionNode",
    "ConfidenceSynthesisNode",
    "DeliberationNode",
    "FalsificationNode",
    "InterpretationNode",
    "ReflectionNode",
]


class DeliberationNode(abc.ABC):
    """A debate participant: reads the shared hypothesis set, emits one opinion.

    Failure policy is ``CONTINUE`` by default: one silent specialist
    degrades the debate visibly rather than cancelling it (CogA §3) —
    downstream synthesis sees exactly which voices are missing.
    """

    def __init__(self, *, extra_requires: frozenset[type[object]] = frozenset()) -> None:
        """Configure the node's inputs.

        Args:
            extra_requires: Domain artifact types this deliberator reads in
                addition to the ``HypothesisSet`` (e.g. an observation
                bundle seeded by the caller).
        """
        self._extra_requires = extra_requires

    @property
    @abc.abstractmethod
    def name(self) -> str:
        """Unique node name — conventionally the agent role."""

    @property
    def requires(self) -> frozenset[type[object]]:
        """The shared hypothesis set plus any declared domain inputs."""
        return frozenset({HypothesisSet}) | self._extra_requires

    @property
    def produces(self) -> frozenset[type[object]]:
        """One accumulated ``AgentOpinion``."""
        return frozenset({AgentOpinion})

    @property
    def failure_policy(self) -> FailurePolicy:
        """Debate degrades explicitly; it does not abort on one lost voice."""
        return FailurePolicy.CONTINUE

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Deliberate and wrap the opinion in a report."""
        match await self.deliberate(context):
            case Ok(opinion):
                return Ok(
                    NodeReport(
                        artifacts=(opinion,),
                        summary=f"{opinion.role} assessed "
                        f"{len(opinion.assessments)} hypothesis(es)",
                    )
                )
            case Err(failure):
                return Err(failure)

    @abc.abstractmethod
    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        """Form this participant's opinion on the shared hypothesis set."""


class FalsificationNode(abc.ABC):
    """The mandatory adversarial stage (CC §9).

    Aborts the run on failure by default: a run that cannot attempt to
    prove itself wrong must not quietly proceed to a decision — and the
    assembly-time constitutional gate guarantees no decision node runs
    without this stage's report.
    """

    @property
    def name(self) -> str:
        """Node name."""
        return "falsification"

    @property
    def requires(self) -> frozenset[type[object]]:
        """The hypothesis set and the debate's accumulated opinions."""
        return frozenset({HypothesisSet, AgentOpinion})

    @property
    def produces(self) -> frozenset[type[object]]:
        """The coverage-attested falsification report."""
        return frozenset({FalsificationReport})

    @property
    def failure_policy(self) -> FailurePolicy:
        """No falsification, no decision — failure aborts the run."""
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Falsify and wrap the report."""
        match await self.falsify(context):
            case Ok(report):
                return Ok(
                    NodeReport(
                        artifacts=(report,),
                        summary=f"raised {len(report.challenges)} challenge(s) "
                        f"across {len(report.examined_hypothesis_ids)} hypothesis(es)",
                    )
                )
            case Err(failure):
                return Err(failure)

    @abc.abstractmethod
    async def falsify(self, context: GraphContext) -> Result[FalsificationReport, NodeFailure]:
        """Actively search for what would prove each hypothesis wrong."""


class ConfidenceSynthesisNode:
    """Deterministic confidence aggregation as a pipeline stage.

    Not abstract and not overridable-by-prompt: the arithmetic is plain
    code (Standing Rule 4). Its judgment inputs are entirely upstream —
    opinions and challenges — exactly as CogA §3 stage 8 demands.
    """

    @property
    def name(self) -> str:
        """Node name."""
        return "confidence_synthesis"

    @property
    def requires(self) -> frozenset[type[object]]:
        """Hypotheses, all opinions, and the falsification report."""
        return frozenset({HypothesisSet, AgentOpinion, FalsificationReport})

    @property
    def produces(self) -> frozenset[type[object]]:
        """The per-hypothesis confidence report."""
        return frozenset({ConfidenceReport})

    @property
    def failure_policy(self) -> FailurePolicy:
        """Synthesis is load-bearing for any decision: failure aborts."""
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Aggregate accumulated debate state into confidence levels."""
        report = synthesize_confidence(
            context.get(HypothesisSet),
            context.opinions(),
            context.get(FalsificationReport),
        )
        return Ok(
            NodeReport(
                artifacts=(report,),
                summary=f"synthesized confidence for {len(report.assessments)} hypothesis(es)",
            )
        )


class ChiefDecisionNode:
    """The terminal synthesis stage, delegating judgment to a port.

    The node owns the *contract* (it structurally requires the debate,
    falsification, and confidence products — the assembly-time gate checks
    exactly this); the injected ``ChiefDecisionPort`` owns the *judgment*
    (deterministic reference now, LLM-backed in Phase 2B — same node).
    """

    def __init__(self, decider: ChiefDecisionPort) -> None:
        """Inject the synthesis strategy (constructor injection, CA §19)."""
        self._decider = decider

    @property
    def name(self) -> str:
        """Node name."""
        return "chief_decision"

    @property
    def requires(self) -> frozenset[type[object]]:
        """Everything the run accumulated: the constitutional gate's shape."""
        return frozenset({HypothesisSet, AgentOpinion, FalsificationReport, ConfidenceReport})

    @property
    def produces(self) -> frozenset[type[object]]:
        """The run's Conclusion."""
        return frozenset({Conclusion})

    @property
    def failure_policy(self) -> FailurePolicy:
        """No decision stage, no run: failure aborts."""
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Synthesize the conclusion from accumulated state."""
        conclusion = self._decider.conclude(
            context.get(HypothesisSet),
            context.opinions(),
            context.get(FalsificationReport),
            context.get(ConfidenceReport),
        )
        return Ok(
            NodeReport(
                artifacts=(conclusion,),
                summary=(
                    "concluded: inaction"
                    if conclusion.is_inaction
                    else f"concluded: {conclusion.chosen.statement}"
                ),
            )
        )


class InterpretationNode(abc.ABC):
    """The perception-to-understanding stage (CogA §3 stage 2).

    Reads the seeded ``ObservationSet`` and produces an ``Interpretation``
    — labeled claims with provenance back to the observations they read.
    Aborts on failure: a run that cannot understand its inputs must not
    quietly hypothesize over nothing.
    """

    @property
    def name(self) -> str:
        """Node name."""
        return "interpretation"

    @property
    def requires(self) -> frozenset[type[object]]:
        """The run's observations."""
        return frozenset({ObservationSet})

    @property
    def produces(self) -> frozenset[type[object]]:
        """Labeled claims with observation provenance."""
        return frozenset({Interpretation})

    @property
    def failure_policy(self) -> FailurePolicy:
        """No understanding, no reasoning: failure aborts."""
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Interpret and wrap the result."""
        match await self.interpret(context):
            case Ok(interpretation):
                return Ok(
                    NodeReport(
                        artifacts=(interpretation,),
                        summary=f"derived {len(interpretation.claims)} claim(s) "
                        f"from {len(interpretation.interpreted_from)} observation(s)",
                    )
                )
            case Err(failure):
                return Err(failure)

    @abc.abstractmethod
    async def interpret(self, context: GraphContext) -> Result[Interpretation, NodeFailure]:
        """Label what the observations mean, with epistemic honesty (CC §8)."""


class ReflectionNode(abc.ABC):
    """The pre-outcome reflection stage (CogA §3 stage 12).

    Runs after the conclusion exists and locks in the pre-registered
    falsification condition plus open uncertainties, so the slow loop can
    later grade reality against a commitment (CC §4). Failure policy is
    ``CONTINUE``: a failed reflection degrades the record loudly but does
    not retract a decision already made — the trace shows the gap.
    """

    @property
    def name(self) -> str:
        """Node name."""
        return "reflection"

    @property
    def requires(self) -> frozenset[type[object]]:
        """The run's conclusion."""
        return frozenset({Conclusion})

    @property
    def produces(self) -> frozenset[type[object]]:
        """The locked-in pre-outcome reflection."""
        return frozenset({Reflection})

    @property
    def failure_policy(self) -> FailurePolicy:
        """Reflection degrades the record; it does not retract decisions."""
        return FailurePolicy.CONTINUE

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        """Reflect and wrap the result."""
        match await self.reflect(context):
            case Ok(reflection):
                return Ok(
                    NodeReport(
                        artifacts=(reflection,),
                        summary="locked in falsification condition and "
                        f"{len(reflection.open_uncertainties)} open uncertainty(ies)",
                    )
                )
            case Err(failure):
                return Err(failure)

    @abc.abstractmethod
    async def reflect(self, context: GraphContext) -> Result[Reflection, NodeFailure]:
        """State implications and lock in the falsification condition."""
