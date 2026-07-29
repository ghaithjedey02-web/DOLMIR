"""Understanding: label the observations with doctrine, honestly.

Cognitive Architecture §3 stage 2. The model names what was perceived using
ICT/SMC vocabulary ("this looks like a fair value gap"), but every label is
recorded as an ``ASSUMPTION``, never a ``FACT`` — an interpretation is not
grounded doctrine, and conflating the two is exactly what Cognitive
Constitution §8 forbids. Provenance flows through ``interpreted_from`` back
to the observations the labels rest on.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.agents.stages import InterpretationNode
from dolmir.orchestration.agents.trading.llm_support import complete_json, string_list
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus
from dolmir.orchestration.trace.observation import Interpretation, ObservationSet
from dolmir.providers.llm.port import LLMProviderPort

__all__ = ["IctInterpretationNode"]

_SYSTEM = (
    "You are an ICT/Smart-Money-Concepts interpreter. Label what the "
    "observations show using precise doctrine terms (fair value gap, "
    "liquidity sweep, order block, break of structure, premium/discount, "
    "session context). Every label is a working interpretation, not a "
    "proven fact. Do not predict direction here."
)


class IctInterpretationNode(InterpretationNode):
    """Turns the observation set into labeled, epistemically-honest claims."""

    def __init__(self, provider: LLMProviderPort) -> None:
        """Inject the interpreting provider."""
        self._provider = provider

    async def interpret(self, context: GraphContext) -> Result[Interpretation, NodeFailure]:
        """Ask the model to label the observations, as assumptions."""
        observations = context.get(ObservationSet)
        user = (
            "Observations transcribed from the chart:\n"
            + "\n".join(f"- {member.content}" for member in observations.members)
            + '\n\nReturn JSON: {"labels": ["<doctrine label of one observation>", ...]}. '
            "Each label is a short interpretive statement."
        )

        match await complete_json(self._provider, system=_SYSTEM, user=user, node_name=self.name):
            case Ok(document):
                labels = string_list(document.get("labels"))
                if not labels:
                    return Err(
                        NodeFailure(
                            node_name=self.name,
                            kind=FailureKind.EXTERNAL_ERROR,
                            message="interpretation produced no labeled claims",
                        )
                    )
                claims = tuple(
                    Claim(statement=label, status=EpistemicStatus.ASSUMPTION) for label in labels
                )
                return Ok(Interpretation(claims=claims, interpreted_from=observations.ids()))
            case Err(failure):
                return Err(failure)
