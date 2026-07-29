"""Risk Engine domain: the deterministic Risk Gate and its value objects.

Zero project dependencies beyond kernel (enforced): the gate is pure,
LLM-free, and exhaustively unit-testable. The orchestration-side risk-
evaluation node imports these types and maps the gate's verdict onto the
generic ``RiskAssessment`` the reasoning trace records.
"""

from dolmir.engines.risk_engine.domain.gate import (
    ApprovedTrade,
    RiskGate,
    RiskVerdict,
    VetoedTrade,
)
from dolmir.engines.risk_engine.domain.limits import RiskLimits
from dolmir.engines.risk_engine.domain.proposal import TradeDirection, TradeProposal

__all__ = [
    "ApprovedTrade",
    "RiskGate",
    "RiskLimits",
    "RiskVerdict",
    "TradeDirection",
    "TradeProposal",
    "VetoedTrade",
]
