"""The scripted fake provider and the cost/latency instrumentation wrapper."""

from __future__ import annotations

import asyncio

from dolmir.kernel.shared_kernel import Err, Ok
from dolmir.providers.llm import (
    CostBook,
    InstrumentedLLMProvider,
    LLMError,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    ModelPricing,
    ScriptedLLMProvider,
    ScriptedReply,
    TokenUsage,
    UsageLedger,
)


def _request(text: str, *, model: str = "scripted-model") -> LLMRequest:
    return LLMRequest(model=model, messages=(LLMMessage.user_text(text),))


async def test_scripted_provider_matches_by_content_not_order() -> None:
    provider = ScriptedLLMProvider(
        [
            ScriptedReply(match="ALPHA", text="alpha reply"),
            ScriptedReply(match="BETA", text="beta reply"),
        ]
    )

    # Fire both concurrently: content matching must be order-independent.
    beta, alpha = await asyncio.gather(
        provider.complete(_request("please handle BETA")),
        provider.complete(_request("please handle ALPHA")),
    )

    assert isinstance(alpha, Ok)
    assert alpha.value.text == "alpha reply"
    assert isinstance(beta, Ok)
    assert beta.value.text == "beta reply"


async def test_scripted_provider_reports_no_match() -> None:
    provider = ScriptedLLMProvider([ScriptedReply(match="ONLY", text="x")])
    result = await provider.complete(_request("nothing relevant"))
    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.PROVIDER_ERROR


async def test_scripted_provider_can_yield_errors() -> None:
    provider = ScriptedLLMProvider(
        [ScriptedReply(match="BOOM", error=LLMError(kind=LLMErrorKind.TIMEOUT, message="slow"))]
    )
    result = await provider.complete(_request("BOOM"))
    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.TIMEOUT


def test_cost_book_prefix_match_and_estimate() -> None:
    book = CostBook(
        {"claude-sonnet": ModelPricing(input_usd_per_mtok=3.0, output_usd_per_mtok=15.0)}
    )
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000)
    # Prefix match: "claude-sonnet-4-5" resolves to the "claude-sonnet" entry.
    assert book.estimate("claude-sonnet-4-5", usage) == 18.0
    # Unknown model estimates to zero (tokens still counted elsewhere).
    assert book.estimate("mystery-model", usage) == 0.0


async def test_instrumentation_records_per_call_cost_and_latency() -> None:
    inner = ScriptedLLMProvider(
        [ScriptedReply(match="WORK", text="done", input_tokens=1000, output_tokens=500)],
        model="claude-sonnet-4-5",
    )
    ledger = UsageLedger()
    book = CostBook(
        {"claude-sonnet": ModelPricing(input_usd_per_mtok=3.0, output_usd_per_mtok=15.0)}
    )
    provider = InstrumentedLLMProvider(inner, purpose="analyst", ledger=ledger, cost_book=book)

    result = await provider.complete(_request("WORK", model="claude-sonnet-4-5"))

    assert isinstance(result, Ok)
    assert ledger.call_count == 1
    record = ledger.records[0]
    assert record.purpose == "analyst"
    assert record.succeeded is True
    assert record.usage.total_tokens == 1500
    # 1000 * 3/1e6 + 500 * 15/1e6 = 0.003 + 0.0075
    assert record.cost_usd == 0.0105
    assert ledger.total_tokens == 1500
    assert "1 model call" in ledger.summary()


async def test_instrumentation_records_failures_with_zero_cost() -> None:
    inner = ScriptedLLMProvider(
        [ScriptedReply(match="FAIL", error=LLMError(kind=LLMErrorKind.RATE_LIMIT, message="429"))]
    )
    ledger = UsageLedger()
    provider = InstrumentedLLMProvider(inner, purpose="analyst", ledger=ledger)

    result = await provider.complete(_request("FAIL"))

    assert isinstance(result, Err)
    assert ledger.call_count == 1
    assert ledger.records[0].succeeded is False
    assert ledger.total_cost_usd == 0.0
    assert "1 failed" in ledger.summary()
