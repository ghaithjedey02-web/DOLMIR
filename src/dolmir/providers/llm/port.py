"""The LLM provider port — the seam every model plugs into.

Core Architecture §6/§7: one ``LLMProviderPort``, many adapters (Anthropic
first, others behind the same interface later). Callers depend on this
Protocol, never on a concrete provider — which is what makes "AI providers
are replaceable" (EC §4) a tested capability rather than a slogan.

The method returns a ``Result`` rather than raising: with many independent,
independently-failing model calls across a reasoning run, a failed call is
information the pipeline routes around (Core Architecture §8, failure as
data), not an exception that unwinds a debate.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from dolmir.kernel.shared_kernel import Result
from dolmir.providers.llm.messages import LLMError, LLMRequest, LLMResponse

__all__ = ["LLMProviderPort"]


@runtime_checkable
class LLMProviderPort(Protocol):
    """A replaceable large-language-model backend."""

    async def complete(self, request: LLMRequest) -> Result[LLMResponse, LLMError]:
        """Complete ``request``, returning the response or a typed failure."""
        ...

    def supports_vision(self) -> bool:
        """Whether this provider accepts image content blocks."""
        ...

    def supports_structured_output(self) -> bool:
        """Whether this provider offers a native structured-output mode.

        Informational capability flag (Core Architecture §11, provider
        capability asymmetry): a role that depends on native structured
        output can check it before selecting a provider. Phase 2B parses
        prompted JSON and does not require it.
        """
        ...

    @property
    def model_id(self) -> str:
        """The concrete model this provider is configured to call."""
        ...
