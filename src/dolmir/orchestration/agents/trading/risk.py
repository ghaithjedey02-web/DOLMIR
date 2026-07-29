"""Risk evaluation and the risk-gated decision — deterministic, plain code.

Cognitive Architecture §3 stages 9-10. Two nodes, both LLM-free:

- ``TradeRiskEvaluationNode`` runs the chosen scenario's proposal through the
  deterministic ``RiskGate`` and maps its verdict onto the generic
  ``RiskAssessment`` the trace records.
- ``TradeDecisionNode`` turns conclusion + assessment into a ``Decision``.
  The generic ``Decision`` type forbids "act on an actionable conclusion over
  an unacceptable risk" by construction, so a gate veto is represented the
  only honest way it can be: the pragmatic decision collapses to a safe
  inaction, with the veto reasons in its rationale, even though the epistemic
  conclusion favored a trade.
"""

from __future__ import annotations

from dolmir.engines.risk_engine.domain import (
    ApprovedTrade,
    RiskGate,
    RiskLimits,
    TradeProposal,
    VetoedTrade,
)
from dolmir.kernel.shared_kernel import Ok, Result
from dolmir.orchestration.agents.stages import DecisionNode, RiskEvaluationNode
from dolmir.orchestration.agents.trading.plan import ProposedTrades
from dolmir.orchestration.failure import NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import ConfidenceReport
from dolmir.orchestration.trace.decision import (
    Decision,
    IdentifiedRisk,
    RiskAssessment,
    RiskMagnitude,
)
from dolmir.orchestration.trace.hypothesis import HypothesisSet

__all__ = ["TradeDecisionNode", "TradeRiskEvaluationNode"]


class TradeRiskEvaluationNode(RiskEvaluationNode):
    """Maps the Risk Gate's verdict on the chosen trade onto a RiskAssessment."""

    def __init__(self, *, gate: RiskGate, limits: RiskLimits) -> None:
        """Inject the deterministic gate and the standing limits."""
        self._gate = gate
        self._limits = limits

    @property
    def requires(self) -> frozenset[type[object]]:
        """The conclusion and the proposals its chosen scenario may reference."""
        return frozenset({Conclusion, ProposedTrades})

    async def evaluate_risk(self, context: GraphContext) -> Result[RiskAssessment, NodeFailure]:
        """Run the gate (or short-circuit inaction) into a risk verdict."""
        conclusion = context.get(Conclusion)
        if conclusion.is_inaction:
            return Ok(
                RiskAssessment(
                    risks=(),
                    acceptable=True,
                    basis="Inaction carries no market exposure.",
                )
            )

        proposal = context.get(ProposedTrades).for_hypothesis(conclusion.chosen.hypothesis_id)
        if proposal is None:
            return Ok(
                RiskAssessment(
                    risks=(
                        IdentifiedRisk(
                            description=(
                                "the chosen scenario has no concrete trade to size or "
                                "invalidate; it cannot be entered safely"
                            ),
                            magnitude=RiskMagnitude.CRITICAL,
                        ),
                    ),
                    acceptable=False,
                    basis="No concrete proposal exists for the chosen scenario.",
                )
            )

        verdict = self._gate.evaluate(proposal, self._limits)
        match verdict:
            case ApprovedTrade():
                return Ok(_approved_assessment(proposal, verdict))
            case VetoedTrade():
                return Ok(_vetoed_assessment(verdict))


class TradeDecisionNode(DecisionNode):
    """Turns the conclusion and its risk verdict into the pragmatic decision."""

    @property
    def requires(self) -> frozenset[type[object]]:
        """Conclusion, its assessment, the proposals, and the inaction fallback set."""
        return frozenset(
            {Conclusion, RiskAssessment, ProposedTrades, HypothesisSet, ConfidenceReport}
        )

    async def decide(self, context: GraphContext) -> Result[Decision, NodeFailure]:
        """Commit to entering, standing aside, or standing aside on a veto."""
        conclusion = context.get(Conclusion)
        assessment = context.get(RiskAssessment)

        if conclusion.is_inaction:
            return Ok(
                Decision(
                    conclusion=conclusion,
                    risk=assessment,
                    action=f"Stand aside — {conclusion.chosen.statement}",
                )
            )

        if assessment.acceptable:
            proposal = context.get(ProposedTrades).for_hypothesis(conclusion.chosen.hypothesis_id)
            return Ok(
                Decision(
                    conclusion=conclusion,
                    risk=assessment,
                    action=_entry_action(proposal),
                    standing_risks=assessment.risks,
                )
            )

        return Ok(self._veto_decision(context, conclusion, assessment))

    def _veto_decision(
        self, context: GraphContext, conclusion: Conclusion, assessment: RiskAssessment
    ) -> Decision:
        """Collapse a gate veto to a safe inaction decision, keeping the reasons."""
        inaction = context.get(HypothesisSet).inaction
        confidence = context.get(ConfidenceReport)
        veto_conclusion = Conclusion(
            chosen=inaction,
            confidence=confidence.for_hypothesis(inaction.hypothesis_id),
            rationale=(
                f"The reasoning favored '{conclusion.chosen.statement}', but the Risk "
                f"Gate refused it — {assessment.basis} The executed decision is no trade."
            ),
        )
        return Decision(
            conclusion=veto_conclusion,
            risk=RiskAssessment(
                risks=(),
                acceptable=True,
                basis="No position taken; the vetoed trade is not entered.",
            ),
            action=f"Stand aside — Risk Gate veto ({assessment.basis})",
        )


def _approved_assessment(proposal: TradeProposal, verdict: ApprovedTrade) -> RiskAssessment:
    """The risk view of an approved trade: a bounded, stop-mitigated downside."""
    return RiskAssessment(
        risks=(
            IdentifiedRisk(
                description=(
                    f"loses {proposal.risk_fraction_of_equity:.2%} of equity if the "
                    f"{proposal.stop} stop is hit"
                ),
                magnitude=RiskMagnitude.MODERATE,
                mitigation=f"hard stop at {proposal.stop}",
            ),
        ),
        acceptable=True,
        basis=(
            f"Risk Gate APPROVED (reward:risk {verdict.reward_to_risk:.2f}); "
            "within standing limits."
        ),
    )


def _vetoed_assessment(verdict: VetoedTrade) -> RiskAssessment:
    """The risk view of a vetoed trade: every reason as an unmitigated critical risk."""
    return RiskAssessment(
        risks=tuple(
            IdentifiedRisk(description=reason, magnitude=RiskMagnitude.CRITICAL)
            for reason in verdict.reasons
        ),
        acceptable=False,
        basis="Risk Gate VETOED: " + "; ".join(verdict.reasons),
    )


def _entry_action(proposal: TradeProposal | None) -> str:
    """Render an approved trade as a legible entry instruction."""
    if proposal is None:  # pragma: no cover — an approved assessment implies a proposal
        return "ENTER (proposal missing)"
    return (
        f"ENTER {proposal.direction.value.upper()} {proposal.symbol} @ {proposal.entry}, "
        f"stop {proposal.stop}, target {proposal.target}, "
        f"risk {proposal.risk_fraction_of_equity:.2%}"
    )
