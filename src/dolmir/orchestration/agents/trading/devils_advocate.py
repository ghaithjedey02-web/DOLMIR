"""The Devil's Advocate: mandatory adversarial falsification.

Cognitive Architecture §3 stage 7 / Cognitive Constitution §9. Falsification
is not "another opinion" — it is an active search for what would prove each
hypothesis wrong, and it is unskippable: the graph will not assemble a
deciding pipeline without it, and this node aborts the run on failure rather
than let a decision proceed unchallenged.

The report attests coverage of *every* hypothesis (``for_hypotheses``), so
"we only stress-tested the ones we liked" is unrepresentable — finding no
objection to a hypothesis is a legitimate result; not examining it is not.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.agents.stages import FalsificationNode
from dolmir.orchestration.agents.trading.llm_support import (
    complete_json,
    object_list,
    string_field,
)
from dolmir.orchestration.agents.trading.presentation import (
    hypothesis_for_label,
    render_hypotheses,
)
from dolmir.orchestration.failure import NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.challenge import Challenge, ChallengeSeverity, FalsificationReport
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.transport import JsonValue

__all__ = ["DevilsAdvocateNode"]

_SYSTEM = (
    "You are the Devil's Advocate. Attack the leading hypothesis and probe "
    "every scenario for disconfirming evidence: overlooked liquidity, higher-"
    "timeframe conflict, a weak or ambiguous invalidation, session/time risk. "
    "State only objections you can justify; if a scenario is genuinely sound, "
    "say so by omitting a challenge for it."
)

_SEVERITY_BY_NAME = {severity.value: severity for severity in ChallengeSeverity}


class DevilsAdvocateNode(FalsificationNode):
    """Runs adversarial falsification across the whole hypothesis set."""

    def __init__(self, provider: LLMProviderPort) -> None:
        """Inject the adversary provider."""
        self._provider = provider

    async def falsify(self, context: GraphContext) -> Result[FalsificationReport, NodeFailure]:
        """Search for what would prove each hypothesis wrong."""
        hypotheses = context.get(HypothesisSet)
        user = (
            f"Candidate scenarios:\n{render_hypotheses(hypotheses)}\n\n"
            'Return JSON: {"challenges": [{"hypothesis": "H1", "objection": "...", '
            '"severity": "minor|material|severe"}]}. Include only real objections.'
        )

        match await complete_json(self._provider, system=_SYSTEM, user=user, node_name=self.name):
            case Ok(document):
                challenges = _challenges(document.get("challenges"), hypotheses=hypotheses)
                return Ok(FalsificationReport.for_hypotheses(hypotheses, challenges))
            case Err(failure):
                return Err(failure)


def _challenges(raw: JsonValue, *, hypotheses: HypothesisSet) -> tuple[Challenge, ...]:
    """Parse challenges, mapping each to a real hypothesis and severity."""
    challenges: list[Challenge] = []
    for entry in object_list(raw):
        hypothesis = hypothesis_for_label(hypotheses, string_field(entry, "hypothesis"))
        objection = string_field(entry, "objection")
        if hypothesis is None or not objection:
            continue
        severity = _SEVERITY_BY_NAME.get(
            string_field(entry, "severity").lower(), ChallengeSeverity.MINOR
        )
        challenges.append(
            Challenge(
                hypothesis_id=hypothesis.hypothesis_id,
                objection=objection,
                severity=severity,
            )
        )
    return tuple(challenges)
