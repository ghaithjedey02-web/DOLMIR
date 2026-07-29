"""The trading agent society — Phase 2B's four agents plus the fast-loop nodes.

These are concrete subclasses of the Phase 2A stage bases (and one direct
two-artifact node): domain-specific reasoning that runs on the generic
kernel. They live in ``orchestration`` because they *are* graph nodes and
import the trace vocabulary; orchestration may depend on engines and
providers (Core Architecture §4), which is how a trading node reaches the
Risk Gate and the LLM/vision providers without the generic engine ever
learning what a trade is.

The four named agents (Core Architecture §8): Market/ICT Analyst and Risk
Manager Agent (debate), Devil's Advocate (falsification), Chief Decision
Agent (synthesis). The Risk Gate is deliberately *not* an agent — it is
deterministic code in the Risk Engine, wired in as the risk-evaluation stage.
"""

from dolmir.orchestration.agents.trading.chief import ChiefTradingDecisionNode
from dolmir.orchestration.agents.trading.debate import (
    MarketIctAnalystNode,
    RiskManagerAgentNode,
)
from dolmir.orchestration.agents.trading.devils_advocate import DevilsAdvocateNode
from dolmir.orchestration.agents.trading.graph import TradingWiring, build_trading_graph
from dolmir.orchestration.agents.trading.hypotheses import TradeHypothesisNode
from dolmir.orchestration.agents.trading.perception import ChartPerceptionNode
from dolmir.orchestration.agents.trading.plan import ProposedTrades
from dolmir.orchestration.agents.trading.risk import (
    TradeDecisionNode,
    TradeRiskEvaluationNode,
)
from dolmir.orchestration.agents.trading.understanding import IctInterpretationNode

__all__ = [
    "ChartPerceptionNode",
    "ChiefTradingDecisionNode",
    "DevilsAdvocateNode",
    "IctInterpretationNode",
    "MarketIctAnalystNode",
    "ProposedTrades",
    "RiskManagerAgentNode",
    "TradeDecisionNode",
    "TradeHypothesisNode",
    "TradeRiskEvaluationNode",
    "TradingWiring",
    "build_trading_graph",
]
