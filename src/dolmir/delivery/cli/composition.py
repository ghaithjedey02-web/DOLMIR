"""The CLI's trading composition root.

Core Architecture §19: the delivery adapter is where the object graph is
constructed explicitly, by constructor injection — no framework, no service
locator. This builds the whole live trading runtime from validated settings:
one Anthropic provider, wrapped per agent role with cost instrumentation over
a shared ledger (so cost is attributed per role from the first call, CA §8),
the vision extractor, the deterministic Risk Gate, the SQLite trace store,
and the ``ReasoningSession`` that ties them together.

A future API delivery adapter (Phase 14) writes its own composition root and
reuses exactly this construction pattern.
"""

from __future__ import annotations

from dataclasses import dataclass

from dolmir.engines.risk_engine.domain import RiskGate, RiskLimits
from dolmir.kernel.clock import ClockPort
from dolmir.kernel.config import DolmirSettings
from dolmir.orchestration.agents.trading import TradingWiring, build_trading_graph
from dolmir.orchestration.graph.executor import GraphExecutor
from dolmir.orchestration.graph.graph import ReasoningGraph
from dolmir.orchestration.session import ReasoningSession
from dolmir.orchestration.trace.sqlite_repository import SqliteReasoningTraceRepository
from dolmir.providers.llm import (
    AnthropicLLMProvider,
    CostBook,
    InstrumentedLLMProvider,
    ModelPricing,
    UrllibHttpTransport,
    UsageLedger,
)
from dolmir.providers.vision import AnthropicChartVisionExtractor

__all__ = ["MissingApiKeyError", "TradingRuntime", "build_trading_runtime"]

# Representative, honestly-estimated USD prices per million tokens. Vendor
# pricing drifts; these exist so cost is a real number rather than always
# zero, not so it is exact (Cognitive Constitution §5).
_DEFAULT_PRICING = {
    "claude-haiku": ModelPricing(input_usd_per_mtok=0.80, output_usd_per_mtok=4.00),
    "claude-sonnet": ModelPricing(input_usd_per_mtok=3.00, output_usd_per_mtok=15.00),
    "claude-opus": ModelPricing(input_usd_per_mtok=15.00, output_usd_per_mtok=75.00),
}


class MissingApiKeyError(Exception):
    """A live analysis was requested but no LLM API key is configured."""


@dataclass(frozen=True, kw_only=True, slots=True)
class TradingRuntime:
    """The assembled live runtime for one or more analyses."""

    session: ReasoningSession
    graph: ReasoningGraph
    ledger: UsageLedger
    repository: SqliteReasoningTraceRepository

    def close(self) -> None:
        """Release the trace store's connection."""
        self.repository.close()


def build_trading_runtime(settings: DolmirSettings, *, clock: ClockPort) -> TradingRuntime:
    """Construct the live trading runtime from validated settings.

    Raises:
        MissingApiKeyError: If no LLM API key is configured — surfaced so the
            CLI can fail loudly and legibly rather than at the first call.
    """
    if settings.llm.api_key is None:
        msg = (
            "no LLM API key configured; set DOLMIR_LLM__API_KEY to run a live "
            "analysis (the reasoning engine and Risk Gate run offline, but the "
            "agents need a model)"
        )
        raise MissingApiKeyError(msg)

    base = AnthropicLLMProvider(
        transport=UrllibHttpTransport(timeout_seconds=settings.llm.timeout_seconds),
        api_key=settings.llm.api_key,
        model=settings.llm.model,
        api_url=settings.llm.base_url,
    )
    ledger = UsageLedger()
    cost_book = CostBook(_DEFAULT_PRICING)

    def metered(purpose: str) -> InstrumentedLLMProvider:
        return InstrumentedLLMProvider(base, purpose=purpose, ledger=ledger, cost_book=cost_book)

    wiring = TradingWiring(
        extractor=AnthropicChartVisionExtractor(
            provider=metered("vision"), max_tokens=settings.llm.max_tokens
        ),
        interpreter=metered("interpretation"),
        hypothesizer=metered("hypothesis"),
        market_analyst=metered("market_ict_analyst"),
        risk_manager=metered("risk_manager_agent"),
        devils_advocate=metered("devils_advocate"),
        chief=metered("chief_decision"),
        gate=RiskGate(),
        limits=RiskLimits(
            max_risk_fraction_per_trade=settings.risk.max_risk_fraction_per_trade,
            min_reward_to_risk=settings.risk.min_reward_to_risk,
        ),
    )
    repository = SqliteReasoningTraceRepository.open(settings.persistence.trace_db_path)
    session = ReasoningSession(executor=GraphExecutor(clock=clock), trace_repository=repository)
    return TradingRuntime(
        session=session,
        graph=build_trading_graph(wiring),
        ledger=ledger,
        repository=repository,
    )
