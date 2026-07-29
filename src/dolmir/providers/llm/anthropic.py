"""The Anthropic (Claude) adapter — the template for every future provider.

This class is deliberately thin and total: it turns an ``LLMRequest`` into
the Anthropic Messages API shape, posts it through the injected transport,
and turns the reply back into an ``LLMResponse`` — mapping every failure
mode to a typed ``LLMError`` instead of raising. Because all of that is
pure over the transport, the contract test suite drives it entirely from
recorded cassettes: no API key, no network, fully deterministic. A second
provider (Phase 11) is a second class exactly like this one.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.providers.llm.messages import (
    ContentBlock,
    ImageBlock,
    LLMError,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    LLMResponse,
    TextBlock,
    TokenUsage,
)
from dolmir.providers.llm.transport import (
    AsyncHttpTransport,
    HttpResponse,
    JsonValue,
    TransportError,
)

__all__ = ["AnthropicLLMProvider"]

_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"
_HTTP_OK = 200

_STATUS_TO_KIND = {
    400: LLMErrorKind.INVALID_REQUEST,
    401: LLMErrorKind.AUTH,
    403: LLMErrorKind.AUTH,
    404: LLMErrorKind.INVALID_REQUEST,
    408: LLMErrorKind.TIMEOUT,
    429: LLMErrorKind.RATE_LIMIT,
}


class AnthropicLLMProvider:
    """An ``LLMProviderPort`` backed by Anthropic's Messages API."""

    def __init__(  # noqa: PLR0913 — an adapter binds transport, credentials, model, endpoint, and capability flags
        self,
        *,
        transport: AsyncHttpTransport,
        api_key: str,
        model: str,
        api_url: str = _MESSAGES_URL,
        supports_vision: bool = True,
        supports_structured_output: bool = True,
    ) -> None:
        """Configure the adapter.

        Args:
            transport: The HTTP seam (real in production, cassette in tests).
            api_key: The Anthropic API key — supplied through validated
                config, never read from ``os.environ`` here (CA §10).
            model: The concrete model id this provider calls.
            api_url: The Messages endpoint (overridable for a proxy/base-url).
            supports_vision: Capability flag surfaced via the port.
            supports_structured_output: Capability flag surfaced via the port.
        """
        self._transport = transport
        self._api_key = api_key
        self._model = model
        self._api_url = api_url
        self._supports_vision = supports_vision
        self._supports_structured_output = supports_structured_output

    @property
    def model_id(self) -> str:
        """The configured model id."""
        return self._model

    def supports_vision(self) -> bool:
        """Whether image blocks may be sent to this provider."""
        return self._supports_vision

    def supports_structured_output(self) -> bool:
        """Whether this provider advertises a native structured-output mode."""
        return self._supports_structured_output

    async def complete(self, request: LLMRequest) -> Result[LLMResponse, LLMError]:
        """Call the Messages API and normalize the outcome."""
        payload = self._build_payload(request)
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
        }
        try:
            response = await self._transport.post_json(
                url=self._api_url, headers=headers, payload=payload
            )
        except TransportError as exc:
            return Err(LLMError(kind=LLMErrorKind.TRANSPORT, message=str(exc)))

        if response.status_code != _HTTP_OK:
            return Err(self._error_from_response(response))
        return self._parse_success(response, requested_model=request.model)

    def _build_payload(self, request: LLMRequest) -> dict[str, JsonValue]:
        """Render an ``LLMRequest`` into the Messages API request body."""
        payload: dict[str, JsonValue] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "messages": [self._render_message(message) for message in request.messages],
        }
        if request.system is not None:
            payload["system"] = request.system
        return payload

    def _render_message(self, message: LLMMessage) -> JsonValue:
        """Render one message into API shape."""
        return {
            "role": message.role.value,
            "content": [self._render_block(block) for block in message.content],
        }

    @staticmethod
    def _render_block(block: ContentBlock) -> JsonValue:
        """Render one content block into API shape."""
        match block:
            case TextBlock():
                return {"type": "text", "text": block.text}
            case ImageBlock():
                return {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": block.media_type,
                        "data": block.data_base64,
                    },
                }

    def _error_from_response(self, response: HttpResponse) -> LLMError:
        """Map a non-200 response to a typed error, keeping the API's message."""
        kind = _STATUS_TO_KIND.get(response.status_code, LLMErrorKind.PROVIDER_ERROR)
        detail = self._extract_error_message(response.body) or f"HTTP {response.status_code}"
        return LLMError(kind=kind, message=f"anthropic: {detail}")

    def _parse_success(
        self, response: HttpResponse, *, requested_model: str
    ) -> Result[LLMResponse, LLMError]:
        """Parse a 200 response body into an ``LLMResponse``."""
        body = response.body
        if not isinstance(body, dict):
            return self._bad_response("response body was not a JSON object")

        text = self._extract_text(body.get("content"))
        if text is None:
            return self._bad_response("response contained no text content block")

        usage = self._extract_usage(body.get("usage"))
        if usage is None:
            return self._bad_response("response was missing a usage block")

        model = body.get("model")
        stop_reason = body.get("stop_reason")
        return Ok(
            LLMResponse(
                text=text,
                usage=usage,
                model=model if isinstance(model, str) else requested_model,
                stop_reason=stop_reason if isinstance(stop_reason, str) else None,
            )
        )

    @staticmethod
    def _extract_text(content: JsonValue) -> str | None:
        """Concatenate the text of every text block; ``None`` if none exist."""
        if not isinstance(content, list):
            return None
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
        if not parts:
            return None
        return "".join(parts)

    @staticmethod
    def _extract_usage(usage: JsonValue) -> TokenUsage | None:
        """Read input/output token counts, tolerating their absence as zero."""
        if not isinstance(usage, dict):
            return None
        input_tokens = usage.get("input_tokens", 0)
        output_tokens = usage.get("output_tokens", 0)
        if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
            return None
        return TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens)

    @staticmethod
    def _extract_error_message(body: JsonValue) -> str | None:
        """Pull ``error.message`` out of an Anthropic error body, if present."""
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message.strip():
                    return message
        return None

    @staticmethod
    def _bad_response(detail: str) -> Result[LLMResponse, LLMError]:
        """Build a ``BAD_RESPONSE`` error result."""
        return Err(LLMError(kind=LLMErrorKind.BAD_RESPONSE, message=f"anthropic: {detail}"))
