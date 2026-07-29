"""Assembles the trading fast-loop into one validated reasoning graph.

The nodes declare artifact *types*; the graph derives the ordering from them
(Core Architecture §8), so this builder only lists the stages and their
wiring — perception → understanding → hypotheses → debate → falsification →
confidence → chief → risk evaluation → decision. Assembly also runs the
constitutional gate (a deciding graph without falsification and confidence
cannot be built), so a mis-wired pipeline fails here, loudly, before any
chart is ever analyzed.

Per-role providers are injected (Core Architecture §8/§10: which model powers
which role is configuration): the composition root can hand the cheapest
model to mechanical roles and the most capable to the Devil's Advocate and
Chief, all sharing one cost ledger.
"""

from __future__ import annotations

from dataclasses import dataclass

from dolmir.engines.risk_engine.domain import RiskGate, RiskLimits
from dolmir.orchestration.agents.stages import ConfidenceSynthesisNode
from dolmir.orchestration.agents.trading.chief import ChiefTradingDecisionNode
from dolmir.orchestration.agents.trading.debate import (
    MarketIctAnalystNode,
    RiskManagerAgentNode,
)
from dolmir.orchestration.agents.trading.devils_advocate import DevilsAdvocateNode
from dolmir.orchestration.agents.trading.hypotheses import TradeHypothesisNode
from dolmir.orchestration.agents.trading.perception import ChartPerceptionNode
from dolmir.orchestration.agents.trading.risk import (
    TradeDecisionNode,
    TradeRiskEvaluationNode,
)
from dolmir.orchestration.agents.trading.understanding import IctInterpretationNode
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.vision.port import ChartVisionExtractorPort
from dolmir.providers.vision.reading import ChartImage

__all__ = ["TradingWiring", "build_trading_graph"]


@dataclass(frozen=True, kw_only=True, slots=True)
class TradingWiring:
    """Everything the trading graph needs, injected at the composition root.

    Each LLM role is a separate ``LLMProviderPort`` so per-role model choice
    and per-role cost attribution are real (they can all wrap one base
    provider). The extractor is the vision provider; the gate and limits
    drive the deterministic risk stage.
    """

    extractor: ChartVisionExtractorPort
    interpreter: LLMProviderPort
    hypothesizer: LLMProviderPort
    market_analyst: LLMProviderPort
    risk_manager: LLMProviderPort
    devils_advocate: LLMProviderPort
    chief: LLMProviderPort
    gate: RiskGate
    limits: RiskLimits


def build_trading_graph(wiring: TradingWiring) -> ReasoningGraph:
    """Assemble and validate the trading fast-loop graph."""
    return ReasoningGraph(
        (
            ChartPerceptionNode(wiring.extractor),
            IctInterpretationNode(wiring.interpreter),
            TradeHypothesisNode(wiring.hypothesizer),
            MarketIctAnalystNode(wiring.market_analyst),
            RiskManagerAgentNode(wiring.risk_manager),
            DevilsAdvocateNode(wiring.devils_advocate),
            ConfidenceSynthesisNode(),
            ChiefTradingDecisionNode(wiring.chief),
            TradeRiskEvaluationNode(gate=wiring.gate, limits=wiring.limits),
            TradeDecisionNode(),
        ),
        seed_types=frozenset({ChartImage}),
    )
