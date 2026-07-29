"""The trading fast loop, end to end, on three scripted charts.

This is Phase 2B's acceptance test (Core Architecture §20): the vertical
slice — perception → understanding → hypotheses → debate → falsification →
confidence → chief → Risk Gate → explained decision — driven with no model
and no network, so it runs deterministically in CI. Three charts exercise
the three outcomes the exit criteria demand:

- a clean setup the pipeline **acts** on;
- a chart with **no clear edge**, concluded honestly as no-trade;
- a setup the debate likes but the deterministic **Risk Gate vetoes**,
  collapsing to a safe stand-aside even though the reasoning favored a trade.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from dolmir.engines.risk_engine.domain import RiskGate, RiskLimits
from dolmir.kernel.clock import FixedClock
from dolmir.orchestration.agents.trading import TradingWiring, build_trading_graph
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.session import ReasoningSession
from dolmir.orchestration.session.state import CognitiveState
from dolmir.orchestration.trace.record import RunStatus
from dolmir.orchestration.trace.repository import InMemoryReasoningTraceRepository
from dolmir.orchestration.trace.serialization import to_document
from dolmir.providers.llm import (
    CostBook,
    InstrumentedLLMProvider,
    ModelPricing,
    ScriptedLLMProvider,
    ScriptedReply,
    UsageLedger,
)
from dolmir.providers.vision import ChartImage, ChartReading, ScriptedChartVisionExtractor

# System-prompt openers, unique per role — the scripted provider matches on these.
_INTERP = "ICT/Smart-Money-Concepts interpreter"
_HYPO = "hypothesis generator"
_MARKET = "You are the Market/ICT Analyst"
_RISKMGR = "You are the Risk Manager Agent"
_DEVIL = "You are the Devil's Advocate"
_CHIEF = "You are the Chief Decision Agent"

_LIMITS = RiskLimits(max_risk_fraction_per_trade=0.01, min_reward_to_risk=1.5)
_COSTS = CostBook({"scripted": ModelPricing(input_usd_per_mtok=1.0, output_usd_per_mtok=5.0)})

_EXPECTED_STEPS = [
    "perception",
    "interpretation",
    "hypothesis_generation",
    "market_ict_analyst",
    "risk_manager_agent",
    "falsification",
    "confidence_synthesis",
    "chief_decision",
    "risk_evaluation",
    "decision",
]


def _replies(script: dict[str, dict[str, Any]]) -> list[ScriptedReply]:
    return [ScriptedReply(match=marker, text=json.dumps(body)) for marker, body in script.items()]


async def _run(
    *, reading: ChartReading, script: dict[str, dict[str, Any]]
) -> tuple[CognitiveState, UsageLedger]:
    """Run the full trading graph on one scripted chart, returning state + costs."""
    base = ScriptedLLMProvider(_replies(script), model="scripted")
    ledger = UsageLedger()

    def metered(purpose: str) -> InstrumentedLLMProvider:
        return InstrumentedLLMProvider(base, purpose=purpose, ledger=ledger, cost_book=_COSTS)

    wiring = TradingWiring(
        extractor=ScriptedChartVisionExtractor({reading.source_ref: reading}),
        interpreter=metered("interpretation"),
        hypothesizer=metered("hypothesis"),
        market_analyst=metered("market_ict_analyst"),
        risk_manager=metered("risk_manager_agent"),
        devils_advocate=metered("devils_advocate"),
        chief=metered("chief_decision"),
        gate=RiskGate(),
        limits=_LIMITS,
    )
    session = ReasoningSession(
        executor=GraphExecutor(clock=FixedClock(datetime(2026, 7, 29, 13, 0, tzinfo=UTC))),
        trace_repository=InMemoryReasoningTraceRepository(),
    )
    image = ChartImage(
        source_ref=reading.source_ref, media_type="image/png", data_base64="ZmFrZQ=="
    )
    state = await session.run(build_trading_graph(wiring), seeds=(image,))
    return state, ledger


# --------------------------------------------------------------------------- #
# Scenario A — a clean long the pipeline acts on.
# --------------------------------------------------------------------------- #

_LONG_SCRIPT: dict[str, dict[str, Any]] = {
    _INTERP: {"labels": ["bullish order block held", "price trading in discount"]},
    _HYPO: {
        "hypotheses": [
            {
                "statement": "Long continuation from the demand order block",
                "falsification": "a 15m close back below 1.0820",
                "inaction": False,
                "symbol": "EURUSD",
                "direction": "long",
                "entry": 1.085,
                "stop": 1.082,
                "target": 1.094,
                "risk_fraction": 0.008,
            },
            {
                "statement": "No clear edge — stand aside",
                "falsification": "a clean setup forms",
                "inaction": True,
            },
        ]
    },
    _MARKET: {
        "assessments": [
            {
                "hypothesis": "H1",
                "stance": "supports",
                "confidence": "high",
                "reasoning": "clean OB in discount",
            },
            {
                "hypothesis": "H2",
                "stance": "opposes",
                "confidence": "moderate",
                "reasoning": "there is an edge",
            },
        ]
    },
    _RISKMGR: {
        "assessments": [
            {
                "hypothesis": "H1",
                "stance": "supports",
                "confidence": "high",
                "reasoning": "defined 3R invalidation",
            },
            {
                "hypothesis": "H2",
                "stance": "opposes",
                "confidence": "low",
                "reasoning": "risk is bounded",
            },
        ]
    },
    _DEVIL: {
        "challenges": [
            {"hypothesis": "H1", "objection": "HTF could still be bearish", "severity": "minor"}
        ]
    },
    _CHIEF: {
        "choice": "H1",
        "rationale": "Two voices back a clean 3R long; only a minor objection stands.",
    },
}


async def test_clean_setup_is_acted_on() -> None:
    reading = ChartReading(
        source_ref="long-setup.png",
        features=("demand order block near 1.0820", "higher low printed"),
        symbol="EURUSD",
        timeframe="15m",
    )
    state, ledger = await _run(reading=reading, script=_LONG_SCRIPT)

    assert state.trace.status is RunStatus.COMPLETED
    assert [step.node_name for step in state.trace.steps] == _EXPECTED_STEPS

    assert state.acted is True
    assert state.decision is not None
    assert state.decision.action.startswith("ENTER LONG EURUSD")
    assert state.decision.risk.acceptable is True
    assert "APPROVED" in state.decision.risk.basis

    # Cost was tracked on every model call, and the whole run serializes.
    assert ledger.call_count == 6
    assert ledger.total_tokens > 0
    assert ledger.total_cost_usd > 0.0
    json.dumps(to_document(state.trace))


# --------------------------------------------------------------------------- #
# Scenario B — no clear edge; honest no-trade.
# --------------------------------------------------------------------------- #

_NO_EDGE_SCRIPT: dict[str, dict[str, Any]] = {
    _INTERP: {"labels": ["tight range", "no displacement"]},
    _HYPO: {
        "hypotheses": [
            {
                "statement": "Long scalp off range low",
                "falsification": "loses the range low",
                "inaction": False,
                "symbol": "EURUSD",
                "direction": "long",
                "entry": 1.085,
                "stop": 1.083,
                "target": 1.089,
                "risk_fraction": 0.005,
            },
            {
                "statement": "Short scalp off range high",
                "falsification": "reclaims the range high",
                "inaction": False,
                "symbol": "EURUSD",
                "direction": "short",
                "entry": 1.085,
                "stop": 1.087,
                "target": 1.081,
                "risk_fraction": 0.005,
            },
            {
                "statement": "No trade — the range is too tight to define edge",
                "falsification": "a clean displacement breaks the range",
                "inaction": True,
            },
        ]
    },
    _MARKET: {
        "assessments": [
            {
                "hypothesis": "H1",
                "stance": "abstains",
                "confidence": "low",
                "reasoning": "no confirmation",
            },
            {
                "hypothesis": "H2",
                "stance": "abstains",
                "confidence": "low",
                "reasoning": "no confirmation",
            },
            {
                "hypothesis": "H3",
                "stance": "supports",
                "confidence": "moderate",
                "reasoning": "no clean edge",
            },
        ]
    },
    _RISKMGR: {
        "assessments": [
            {"hypothesis": "H1", "stance": "abstains", "confidence": "low", "reasoning": "chop"},
            {"hypothesis": "H2", "stance": "abstains", "confidence": "low", "reasoning": "chop"},
            {
                "hypothesis": "H3",
                "stance": "supports",
                "confidence": "moderate",
                "reasoning": "preserve capital",
            },
        ]
    },
    _DEVIL: {
        "challenges": [
            {
                "hypothesis": "H1",
                "objection": "no confirmation of the low holding",
                "severity": "material",
            },
            {
                "hypothesis": "H2",
                "objection": "no confirmation of the high holding",
                "severity": "material",
            },
        ]
    },
    _CHIEF: {
        "choice": "H3",
        "rationale": "Neither direction has confirmation; standing aside is the honest call.",
    },
}


async def test_no_clear_edge_concludes_no_trade() -> None:
    reading = ChartReading(
        source_ref="no-edge.png", features=("tight consolidation", "overlapping candles")
    )
    state, _ = await _run(reading=reading, script=_NO_EDGE_SCRIPT)

    assert state.trace.status is RunStatus.COMPLETED
    assert state.concluded is True
    assert state.conclusion is not None
    assert state.conclusion.is_inaction is True
    assert state.acted is False
    assert state.decision is not None
    assert state.decision.action.startswith("Stand aside")
    assert state.explanation is not None
    assert "No action" in state.explanation.render_text()


# --------------------------------------------------------------------------- #
# Scenario C — the debate likes it, the Risk Gate vetoes it.
# --------------------------------------------------------------------------- #

_VETO_SCRIPT: dict[str, dict[str, Any]] = {
    _INTERP: {"labels": ["bullish break of structure"]},
    _HYPO: {
        "hypotheses": [
            {
                "statement": "Long the breakout continuation",
                "falsification": "a close back below 1.0810",
                "inaction": False,
                "symbol": "EURUSD",
                "direction": "long",
                "entry": 1.085,
                "stop": 1.081,
                "target": 1.088,
                "risk_fraction": 0.008,
            },
            {
                "statement": "No trade",
                "falsification": "a clean setup forms",
                "inaction": True,
            },
        ]
    },
    _MARKET: {
        "assessments": [
            {
                "hypothesis": "H1",
                "stance": "supports",
                "confidence": "high",
                "reasoning": "strong momentum",
            },
            {
                "hypothesis": "H2",
                "stance": "opposes",
                "confidence": "low",
                "reasoning": "edge exists",
            },
        ]
    },
    _RISKMGR: {
        "assessments": [
            {
                "hypothesis": "H1",
                "stance": "supports",
                "confidence": "high",
                "reasoning": "momentum favors it",
            },
            {"hypothesis": "H2", "stance": "opposes", "confidence": "low", "reasoning": "bounded"},
        ]
    },
    _DEVIL: {
        "challenges": [
            {"hypothesis": "H1", "objection": "target is close to entry", "severity": "minor"}
        ]
    },
    _CHIEF: {"choice": "H1", "rationale": "Strong momentum breakout; the crowd is long."},
}


async def test_debate_favored_trade_is_vetoed_by_the_risk_gate() -> None:
    reading = ChartReading(source_ref="veto.png", features=("break of structure up",))
    state, _ = await _run(reading=reading, script=_VETO_SCRIPT)

    assert state.trace.status is RunStatus.COMPLETED
    assert state.conclusion is not None

    # The reasoning favored the long (epistemic conclusion is actionable)...
    assert state.conclusion.is_inaction is False

    # ...but the deterministic gate vetoed it, so the executed decision is
    # a safe stand-aside, and the run did NOT act.
    assert state.acted is False
    assert state.decision is not None
    assert state.decision.conclusion.is_inaction is True
    assert "veto" in state.decision.action.lower()
    assert "reward-to-risk" in state.decision.action.lower() or "VETOED" in state.decision.action


def test_the_trading_graph_assembles_and_passes_the_constitutional_gate() -> None:
    # Building the graph runs every assembly-time check, including the gate
    # that forbids a deciding pipeline without falsification + confidence.
    wiring = TradingWiring(
        extractor=ScriptedChartVisionExtractor({}),
        interpreter=ScriptedLLMProvider([]),
        hypothesizer=ScriptedLLMProvider([]),
        market_analyst=ScriptedLLMProvider([]),
        risk_manager=ScriptedLLMProvider([]),
        devils_advocate=ScriptedLLMProvider([]),
        chief=ScriptedLLMProvider([]),
        gate=RiskGate(),
        limits=_LIMITS,
    )
    graph = build_trading_graph(wiring)
    node_names = {node.name for node in graph.nodes}
    assert "chief_decision" in node_names
    assert "falsification" in node_names


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
