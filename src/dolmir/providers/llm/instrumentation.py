"""Cost and latency instrumentation, wired in from call number one.

Core Architecture §8: every ``LLMProviderPort`` call is wrapped with
instrumentation capturing tokens, latency, and estimated cost, persisted
alongside the trace. It is cheap to add now and exactly the historical data
a system meant to run for a decade will wish it had kept from day one.

``InstrumentedLLMProvider`` is itself an ``LLMProviderPort``, so it composes
transparently: the reasoning graph sees a provider, not a meter. One
instance is created per agent role (bound to a ``purpose`` label) sharing
one ``UsageLedger``, which yields per-role cost attribution for free.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.providers.llm.messages import LLMError, LLMRequest, LLMResponse, TokenUsage
from dolmir.providers.llm.port import LLMProviderPort

__all__ = [
    "CallRecord",
    "CostBook",
    "InstrumentedLLMProvider",
    "ModelPricing",
    "UsageLedger",
]

_TOKENS_PER_MILLION = 1_000_000


@dataclass(frozen=True, kw_only=True, slots=True)
class ModelPricing:
    """USD price per million input/output tokens for one model."""

    input_usd_per_mtok: float
    output_usd_per_mtok: float

    def __post_init__(self) -> None:
        """Reject negative prices."""
        if self.input_usd_per_mtok < 0 or self.output_usd_per_mtok < 0:
            msg = "ModelPricing values must be non-negative"
            raise ValueError(msg)


class CostBook:
    """Maps model ids to prices and estimates the cost of a call.

    Prices are honest *estimates* (they drift with vendor pricing), so the
    table is overridable through configuration. An unpriced model estimates
    to ``0.0`` — the token counts are still recorded, so the gap is visible
    rather than silently fabricated (Cognitive Constitution §5).
    """

    def __init__(self, pricing: Mapping[str, ModelPricing] | None = None) -> None:
        """Build the cost book, defaulting to a small representative table."""
        self._pricing = dict(pricing) if pricing is not None else {}

    def price_of(self, model: str) -> ModelPricing | None:
        """The pricing for ``model`` by exact match, then longest prefix."""
        if model in self._pricing:
            return self._pricing[model]
        candidates = [key for key in self._pricing if model.startswith(key)]
        if not candidates:
            return None
        return self._pricing[max(candidates, key=len)]

    def estimate(self, model: str, usage: TokenUsage) -> float:
        """Estimated USD cost of ``usage`` at ``model``'s price (``0.0`` if unpriced)."""
        pricing = self.price_of(model)
        if pricing is None:
            return 0.0
        return (
            usage.input_tokens * pricing.input_usd_per_mtok
            + usage.output_tokens * pricing.output_usd_per_mtok
        ) / _TOKENS_PER_MILLION


@dataclass(frozen=True, kw_only=True, slots=True)
class CallRecord:
    """One measured model call: who made it, what it cost, how long it took."""

    purpose: str
    model: str
    usage: TokenUsage
    latency_ms: float
    cost_usd: float
    succeeded: bool


class UsageLedger:
    """Accumulates ``CallRecord``s for one reasoning run (mutable, per-run)."""

    def __init__(self) -> None:
        """Start an empty ledger."""
        self._records: list[CallRecord] = []

    def record(self, entry: CallRecord) -> None:
        """Append one measured call."""
        self._records.append(entry)

    @property
    def records(self) -> tuple[CallRecord, ...]:
        """Every recorded call, in the order they completed."""
        return tuple(self._records)

    @property
    def call_count(self) -> int:
        """How many model calls were made."""
        return len(self._records)

    @property
    def total_cost_usd(self) -> float:
        """Summed estimated cost across all calls."""
        return sum(record.cost_usd for record in self._records)

    @property
    def total_tokens(self) -> int:
        """Summed input+output tokens across all calls."""
        return sum(record.usage.total_tokens for record in self._records)

    def summary(self) -> str:
        """A one-line legible cost/latency summary for the run."""
        failures = sum(1 for record in self._records if not record.succeeded)
        latency = sum(record.latency_ms for record in self._records)
        failure_note = f", {failures} failed" if failures else ""
        return (
            f"{self.call_count} model call(s){failure_note}: "
            f"{self.total_tokens} tokens, ~${self.total_cost_usd:.4f}, "
            f"{latency:.0f} ms total"
        )


class InstrumentedLLMProvider:
    """Wraps a provider, timing and costing every call into a shared ledger."""

    def __init__(
        self,
        inner: LLMProviderPort,
        *,
        purpose: str,
        ledger: UsageLedger,
        cost_book: CostBook | None = None,
    ) -> None:
        """Bind the wrapper to a role ``purpose`` and a shared ``ledger``."""
        self._inner = inner
        self._purpose = purpose
        self._ledger = ledger
        self._cost_book = cost_book if cost_book is not None else CostBook()

    @property
    def model_id(self) -> str:
        """The wrapped provider's model id."""
        return self._inner.model_id

    def supports_vision(self) -> bool:
        """Delegates to the wrapped provider."""
        return self._inner.supports_vision()

    def supports_structured_output(self) -> bool:
        """Delegates to the wrapped provider."""
        return self._inner.supports_structured_output()

    async def complete(self, request: LLMRequest) -> Result[LLMResponse, LLMError]:
        """Call through, recording tokens, latency, and estimated cost."""
        started = time.perf_counter()
        result = await self._inner.complete(request)
        latency_ms = (time.perf_counter() - started) * 1000.0

        match result:
            case Ok(response):
                usage, model, succeeded = response.usage, response.model, True
            case Err(_):
                usage = TokenUsage(input_tokens=0, output_tokens=0)
                model, succeeded = request.model, False

        self._ledger.record(
            CallRecord(
                purpose=self._purpose,
                model=model,
                usage=usage,
                latency_ms=latency_ms,
                cost_usd=self._cost_book.estimate(model, usage),
                succeeded=succeeded,
            )
        )
        return result
