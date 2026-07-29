"""The Chief Decision Agent: LLM judgment, deterministic numbers.

Cognitive Architecture §3 stage 10. The chief synthesizes the debate,
falsification, and confidence into one ``Conclusion`` — it chooses; it does
not investigate or introduce new evidence. Three disciplines are wired in:

- **the confidence level is never the model's to invent** — it is copied
  from the deterministic ``ConfidenceReport`` (Standing Rule 4: deterministic
  numbers, LLM narration on top);
- **the action-bias guard is structural** — an actionable pick whose
  synthesized confidence is below ``MODERATE`` collapses to inaction
  (Cognitive Constitution §6);
- **degradation is explicit** — if the model call fails or returns an
  unusable choice, the node falls back to the deterministic reference
  synthesizer and records that in the step summary, rather than aborting a
  run over a transient model hiccup.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.agents.chief_decision import (
    ChiefDecisionPort,
    DeterministicChiefDecision,
)
from dolmir.orchestration.agents.trading.llm_support import complete_json, string_field
from dolmir.orchestration.agents.trading.presentation import (
    hypothesis_for_label,
    hypothesis_label,
    render_hypotheses,
)
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceReport
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion
from dolmir.providers.llm.port import LLMProviderPort

__all__ = ["ChiefTradingDecisionNode"]

_SYSTEM = (
    "You are the Chief Decision Agent. Weigh the analysts' opinions, the "
    "Devil's Advocate's challenges, and the synthesized confidence, then "
    "choose exactly ONE scenario to act on — or the no-trade scenario if no "
    "edge is clear. You synthesize; you do not introduce new evidence. Acting "
    "on weak conviction is a failure mode, not boldness."
)


class ChiefTradingDecisionNode:
    """Selects the winning hypothesis and accounts for the choice."""

    def __init__(
        self, provider: LLMProviderPort, *, fallback: ChiefDecisionPort | None = None
    ) -> None:
        """Inject the deciding provider and the deterministic fallback."""
        self._provider = provider
        self._fallback = fallback if fallback is not None else DeterministicChiefDecision()

    @property
    def name(self) -> str:
        """Node name."""
        return "chief_decision"

    @property
    def requires(self) -> frozenset[type[object]]:
        """Everything the run accumulated — the constitutional gate's shape."""
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
        """Decide via the model, falling back to deterministic synthesis."""
        hypotheses = context.get(HypothesisSet)
        opinions = context.opinions()
        falsification = context.get(FalsificationReport)
        confidence = context.get(ConfidenceReport)

        conclusion, summary = await self._conclude(hypotheses, opinions, falsification, confidence)
        return Ok(NodeReport(artifacts=(conclusion,), summary=summary))

    async def _conclude(
        self,
        hypotheses: HypothesisSet,
        opinions: tuple[AgentOpinion, ...],
        falsification: FalsificationReport,
        confidence: ConfidenceReport,
    ) -> tuple[Conclusion, str]:
        """Return the conclusion and a one-line account of how it was reached."""
        user = (
            f"Candidate scenarios:\n{render_hypotheses(hypotheses)}\n\n"
            f"Synthesized confidence:\n{_confidence_summary(hypotheses, confidence)}\n\n"
            f"Debate contributed {len(opinions)} opinion(s); "
            f"{len(falsification.challenges)} standing challenge(s).\n\n"
            'Return JSON: {"choice": "H2", "rationale": "why this scenario"}.'
        )
        match await complete_json(self._provider, system=_SYSTEM, user=user, node_name=self.name):
            case Ok(document):
                chosen = hypothesis_for_label(hypotheses, string_field(document, "choice"))
                rationale = string_field(document, "rationale")
                if chosen is not None and rationale:
                    return self._from_choice(
                        chosen, rationale, hypotheses, confidence, falsification
                    )
                summary = "chief: model choice unusable; fell back to deterministic synthesis"
            case Err(failure):
                summary = f"chief: model unavailable ({failure.message}); deterministic fallback"

        fallback = self._fallback.conclude(hypotheses, opinions, falsification, confidence)
        return fallback, summary

    def _from_choice(
        self,
        chosen: Hypothesis,
        rationale: str,
        hypotheses: HypothesisSet,
        confidence: ConfidenceReport,
        falsification: FalsificationReport,
    ) -> tuple[Conclusion, str]:
        """Build the conclusion from the model's pick, guarding action bias."""
        chosen_confidence = confidence.for_hypothesis(chosen.hypothesis_id)
        below_threshold = (
            not chosen.represents_inaction and chosen_confidence.level < Confidence.MODERATE
        )
        if below_threshold:
            inaction = hypotheses.inaction
            conclusion = Conclusion(
                chosen=inaction,
                confidence=confidence.for_hypothesis(inaction.hypothesis_id),
                rationale=(
                    f"The Chief Decision Agent favored '{chosen.statement}', but its "
                    f"synthesized confidence is {chosen_confidence.level.name}, below the "
                    f"MODERATE threshold required to act; choosing inaction "
                    f"(Cognitive Constitution §6). Its reasoning: {rationale}"
                ),
                standing_challenges=falsification.challenges_against(inaction.hypothesis_id),
            )
            return conclusion, "chief: model pick below action threshold — inaction (CC §6)"

        conclusion = Conclusion(
            chosen=chosen,
            confidence=chosen_confidence,
            rationale=rationale,
            standing_challenges=falsification.challenges_against(chosen.hypothesis_id),
        )
        verb = "inaction" if chosen.represents_inaction else "act"
        return conclusion, f"chief: chose to {verb} ({chosen_confidence.level.name} confidence)"


def _confidence_summary(hypotheses: HypothesisSet, confidence: ConfidenceReport) -> str:
    """One labeled line of synthesized confidence per hypothesis."""
    lines: list[str] = []
    for index, member in enumerate(hypotheses.members):
        assessment = confidence.for_hypothesis(member.hypothesis_id)
        lines.append(f"{hypothesis_label(index)}: {assessment.level.name} — {assessment.basis}")
    return "\n".join(lines)
