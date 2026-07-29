"""The debate voices: the Market/ICT Analyst and the Risk Manager Agent.

Cognitive Architecture §3 stage 6. Each is a normal ``DeliberationNode`` that
assesses every hypothesis in the shared set — the Risk Manager Agent
included, which is deliberately *just another voice* with no veto power (the
hard veto lives in the deterministic Risk Gate, Core Architecture §8, not in
an LLM debate participant). A failed voice degrades the debate visibly
rather than cancelling it (``CONTINUE`` policy from the base).
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.agents.stages import DeliberationNode
from dolmir.orchestration.agents.trading.llm_support import (
    complete_json,
    object_list,
    string_field,
)
from dolmir.orchestration.agents.trading.plan import ProposedTrades
from dolmir.orchestration.agents.trading.presentation import (
    hypothesis_for_label,
    parse_confidence,
    parse_stance,
    render_hypotheses,
)
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.observation import Interpretation
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.transport import JsonValue

__all__ = ["MarketIctAnalystNode", "RiskManagerAgentNode"]

_MARKET_STRATEGY = "market-ict-analyst@v1"
_RISK_STRATEGY = "risk-manager-agent@v1"

_ASSESSMENT_SHAPE = (
    'Return JSON: {"assessments": [{"hypothesis": "H1", "stance": '
    '"supports|opposes|abstains", "confidence": "low|moderate|high|very_high", '
    '"reasoning": "...", "evidence": "optional supporting observation"}]}. '
    "Assess every hypothesis."
)

_MARKET_SYSTEM = (
    "You are the Market/ICT Analyst. Weigh the evidence for and against each "
    "scenario using smart-money-concepts reasoning. Argue the read of the "
    "market; do not size positions."
)

_RISK_SYSTEM = (
    "You are the Risk Manager Agent — one debate voice among several, with no "
    "special authority (a separate deterministic gate enforces hard limits). "
    "Assess each scenario for how sound its risk/reward and invalidation are."
)


class MarketIctAnalystNode(DeliberationNode):
    """The combined market-structure / ICT analyst debate voice."""

    def __init__(self, provider: LLMProviderPort) -> None:
        """Inject the provider; declare the interpretation as an extra input."""
        super().__init__(extra_requires=frozenset({Interpretation}))
        self._provider = provider

    @property
    def name(self) -> str:
        """Node name."""
        return "market_ict_analyst"

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        """Form the analyst's opinion on the shared hypothesis set."""
        return await _deliberate(
            self._provider,
            system=_MARKET_SYSTEM,
            hypotheses=context.get(HypothesisSet),
            role=self.name,
            strategy_version=_MARKET_STRATEGY,
        )


class RiskManagerAgentNode(DeliberationNode):
    """The risk-manager debate voice — no veto power, just an opinion."""

    def __init__(self, provider: LLMProviderPort) -> None:
        """Inject the provider; declare the proposed trades as an extra input."""
        super().__init__(extra_requires=frozenset({ProposedTrades}))
        self._provider = provider

    @property
    def name(self) -> str:
        """Node name."""
        return "risk_manager_agent"

    async def deliberate(self, context: GraphContext) -> Result[AgentOpinion, NodeFailure]:
        """Form the risk manager's opinion on the shared hypothesis set."""
        return await _deliberate(
            self._provider,
            system=_RISK_SYSTEM,
            hypotheses=context.get(HypothesisSet),
            role=self.name,
            strategy_version=_RISK_STRATEGY,
        )


async def _deliberate(
    provider: LLMProviderPort,
    *,
    system: str,
    hypotheses: HypothesisSet,
    role: str,
    strategy_version: str,
) -> Result[AgentOpinion, NodeFailure]:
    """Call the provider and parse a complete ``AgentOpinion``."""
    user = f"Candidate scenarios:\n{render_hypotheses(hypotheses)}\n\n{_ASSESSMENT_SHAPE}"
    match await complete_json(provider, system=system, user=user, node_name=role):
        case Ok(document):
            assessments = _assessments(document.get("assessments"), hypotheses=hypotheses)
            if not assessments:
                return Err(
                    NodeFailure(
                        node_name=role,
                        kind=FailureKind.EXTERNAL_ERROR,
                        message="no usable hypothesis assessments returned",
                    )
                )
            return Ok(
                AgentOpinion(
                    role=role, strategy_version=strategy_version, assessments=tuple(assessments)
                )
            )
        case Err(failure):
            return Err(failure)


def _assessments(raw: JsonValue, *, hypotheses: HypothesisSet) -> list[HypothesisAssessment]:
    """Parse per-hypothesis assessments, dropping ones that cannot be grounded."""
    seen: set[str] = set()
    assessments: list[HypothesisAssessment] = []
    for entry in object_list(raw):
        label = string_field(entry, "hypothesis")
        hypothesis = hypothesis_for_label(hypotheses, label)
        reasoning = string_field(entry, "reasoning")
        if hypothesis is None or not reasoning or str(hypothesis.hypothesis_id) in seen:
            continue
        seen.add(str(hypothesis.hypothesis_id))
        assessments.append(
            HypothesisAssessment(
                hypothesis_id=hypothesis.hypothesis_id,
                stance=parse_stance(string_field(entry, "stance")),
                confidence=parse_confidence(string_field(entry, "confidence")),
                reasoning=reasoning,
                evidence=_evidence(string_field(entry, "evidence")),
            )
        )
    return assessments


def _evidence(text: str) -> tuple[Evidence, ...]:
    """Wrap an optional supporting note as observation evidence, if present."""
    if not text:
        return ()
    return (Evidence(kind=EvidenceKind.OBSERVATION, source_ref="chart-analysis", content=text),)
