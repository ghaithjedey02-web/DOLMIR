"""The Chief Decision interface and its deterministic reference synthesizer.

``ChiefDecisionPort`` is the seam where Phase 2B plugs in an LLM-backed
Chief Decision Agent. The deterministic reference implementation shipped
here is not a toy: it is the engine's conservative baseline — the null
model every smarter synthesizer must later beat in evals (Phase 6), and
the proof that the pipeline runs end-to-end with zero model dependency.
"""

from __future__ import annotations

from typing import Protocol

from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceReport
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion

__all__ = ["ChiefDecisionPort", "DeterministicChiefDecision"]


class ChiefDecisionPort(Protocol):
    """Synthesizes debate, falsification, and confidence into a Conclusion.

    Implementations receive everything the run accumulated — they never
    fetch, recompute, or introduce new evidence (Cognitive Architecture §3
    stage 10 synthesizes; it does not investigate).
    """

    def conclude(
        self,
        hypotheses: HypothesisSet,
        opinions: tuple[AgentOpinion, ...],
        falsification: FalsificationReport,
        confidence: ConfidenceReport,
    ) -> Conclusion:
        """Choose one hypothesis and account for the choice."""
        ...


class DeterministicChiefDecision:
    """Conservative, rule-based synthesis — plain code, no LLM.

    Policy (deliberately simple, fully documented, exhaustively testable):

    1. Rank hypotheses by synthesized confidence level.
    2. If the top-ranked *actionable* hypothesis is below ``MODERATE``, or
       ties with the inaction option, choose inaction — acting on weak
       conviction is the Cognitive Constitution's named failure mode
       (CC §6: action bias is a bug).
    3. Ties between actionable hypotheses at equal confidence resolve to
       inaction as well: an unresolved tie *is* the absence of a clear edge.
    4. The rationale states which rule fired; standing challenges against
       the choice are carried into the conclusion, not hidden (CC §11).
    """

    def conclude(
        self,
        hypotheses: HypothesisSet,
        opinions: tuple[AgentOpinion, ...],
        falsification: FalsificationReport,
        confidence: ConfidenceReport,
    ) -> Conclusion:
        """Apply the conservative policy documented on the class."""
        inaction = hypotheses.inaction
        actionable = [member for member in hypotheses if not member.represents_inaction]

        def level(hypothesis: Hypothesis) -> Confidence:
            return confidence.for_hypothesis(hypothesis.hypothesis_id).level

        best_level = max(level(member) for member in actionable)
        leaders = [member for member in actionable if level(member) is best_level]

        if best_level < Confidence.MODERATE:
            chosen, rationale = (
                inaction,
                (
                    f"no actionable hypothesis reached MODERATE confidence "
                    f"(best: {best_level.name}); choosing inaction (CC §6)"
                ),
            )
        elif len(leaders) > 1:
            chosen, rationale = (
                inaction,
                (
                    f"{len(leaders)} hypotheses tied at {best_level.name}; an "
                    "unresolved tie is the absence of a clear edge — choosing "
                    "inaction (CC §6)"
                ),
            )
        elif level(inaction) > best_level:
            chosen, rationale = (
                inaction,
                (
                    f"inaction itself carries the highest confidence "
                    f"({level(inaction).name} vs {best_level.name})"
                ),
            )
        else:
            chosen = leaders[0]
            rationale = (
                f"highest synthesized confidence ({best_level.name}) with no "
                "tie and no stronger case for inaction"
            )

        return Conclusion(
            chosen=chosen,
            confidence=confidence.for_hypothesis(chosen.hypothesis_id),
            rationale=rationale,
            standing_challenges=falsification.challenges_against(chosen.hypothesis_id),
        )
