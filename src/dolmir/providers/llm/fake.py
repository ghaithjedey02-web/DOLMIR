"""A scripted, deterministic provider for pipeline tests.

Distinct from the cassette transport (which replays HTTP for the *Anthropic
adapter's* contract tests), this fake stands in for the whole provider so a
full reasoning-graph run is exercised with no network and no model. It
matches replies by a substring of the rendered request rather than by call
order, because independent debate nodes run concurrently in one wave
(``asyncio.gather``) — an order-based queue would be flaky, a content match
is deterministic.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.providers.llm.messages import (
    LLMError,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    LLMResponse,
    TextBlock,
    TokenUsage,
)

__all__ = ["ScriptedLLMProvider", "ScriptedReply"]


@dataclass(frozen=True, kw_only=True, slots=True)
class ScriptedReply:
    """One canned reply, selected when ``match`` occurs in the request text.

    Exactly one of ``text`` / ``error`` is set: ``text`` yields an ``Ok``
    completion, ``error`` yields an ``Err``. Token counts default to small
    non-zero values so cost instrumentation has something to measure.
    """

    match: str
    text: str | None = None
    error: LLMError | None = None
    input_tokens: int = 100
    output_tokens: int = 50

    def __post_init__(self) -> None:
        """Require exactly one of a text reply or an error reply."""
        if (self.text is None) == (self.error is None):
            msg = "ScriptedReply must set exactly one of text or error"
            raise ValueError(msg)

    def as_result(self, model: str) -> Result[LLMResponse, LLMError]:
        """Build the result this reply represents for ``model``."""
        if self.error is not None:
            return Err(self.error)
        assert self.text is not None
        return Ok(
            LLMResponse(
                text=self.text,
                usage=TokenUsage(input_tokens=self.input_tokens, output_tokens=self.output_tokens),
                model=model,
                stop_reason="end_turn",
            )
        )


class ScriptedLLMProvider:
    """An ``LLMProviderPort`` that answers from a fixed script."""

    def __init__(
        self,
        replies: Sequence[ScriptedReply],
        *,
        model: str = "scripted-model",
        supports_vision: bool = True,
        supports_structured_output: bool = True,
    ) -> None:
        """Configure the fake with its ordered ``replies`` and capabilities."""
        self._replies = tuple(replies)
        self._model = model
        self._supports_vision = supports_vision
        self._supports_structured_output = supports_structured_output

    @property
    def model_id(self) -> str:
        """The fake model id."""
        return self._model

    def supports_vision(self) -> bool:
        """Configured vision capability."""
        return self._supports_vision

    def supports_structured_output(self) -> bool:
        """Configured structured-output capability."""
        return self._supports_structured_output

    async def complete(self, request: LLMRequest) -> Result[LLMResponse, LLMError]:
        """Return the first reply whose ``match`` occurs in the request."""
        rendered = self._render(request)
        for reply in self._replies:
            if reply.match in rendered:
                return reply.as_result(self._model)
        preview = rendered[:120].replace("\n", " ")
        return Err(
            LLMError(
                kind=LLMErrorKind.PROVIDER_ERROR,
                message=f"scripted provider: no reply matched request: {preview!r}",
            )
        )

    @staticmethod
    def _render(request: LLMRequest) -> str:
        """Flatten a request's system prompt and text blocks into one string."""
        parts: list[str] = []
        if request.system is not None:
            parts.append(request.system)
        parts.extend(_message_text(message) for message in request.messages)
        return "\n".join(parts)


def _message_text(message: LLMMessage) -> str:
    """The concatenated text of a message's text blocks (images ignored)."""
    return "\n".join(block.text for block in message.content if isinstance(block, TextBlock))
