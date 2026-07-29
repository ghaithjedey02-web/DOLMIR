"""Contract suite for the Anthropic LLM adapter, driven entirely by cassettes.

This is the template the roadmap calls for: the *real*
``AnthropicLLMProvider`` — its payload building, status handling, and
response parsing — exercised end to end against recorded HTTP exchanges,
with no API key and no network. A second provider (Phase 11) gets a suite
shaped exactly like this one, and the two must agree on the same
``LLMProviderPort`` behavior.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from dolmir.kernel.shared_kernel import Err, Ok
from dolmir.providers.llm import (
    AnthropicLLMProvider,
    Cassette,
    CassetteTransport,
    ImageBlock,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    Role,
    TextBlock,
    TransportError,
)
from dolmir.providers.llm.transport import HttpResponse, JsonValue

_CASSETTE = Path(__file__).parent / "cassettes" / "anthropic_messages.json"


def _provider(transport: CassetteTransport) -> AnthropicLLMProvider:
    return AnthropicLLMProvider(transport=transport, api_key="test-key", model="claude-sonnet-4-5")


@pytest.fixture
def transport() -> CassetteTransport:
    return CassetteTransport(Cassette.from_file(_CASSETTE))


def _request(marker: str) -> LLMRequest:
    return LLMRequest(
        model="claude-sonnet-4-5",
        system="You are a test harness.",
        messages=(LLMMessage.user_text(f"{marker} — please respond."),),
        max_tokens=64,
    )


async def test_successful_completion_is_parsed(transport: CassetteTransport) -> None:
    result = await _provider(transport).complete(_request("PING_SUCCESS"))

    assert isinstance(result, Ok)
    response = result.value
    assert response.text == "pong: the reasoning kernel is reachable."
    assert response.usage.input_tokens == 1280
    assert response.usage.output_tokens == 24
    assert response.usage.total_tokens == 1304
    assert response.model == "claude-sonnet-4-5"
    assert response.stop_reason == "end_turn"


async def test_multiple_text_blocks_are_concatenated(transport: CassetteTransport) -> None:
    result = await _provider(transport).complete(_request("PING_MULTIBLOCK"))

    assert isinstance(result, Ok)
    assert result.value.text == "first. second."


async def test_auth_failure_maps_to_typed_error(transport: CassetteTransport) -> None:
    result = await _provider(transport).complete(_request("PING_AUTH_FAIL"))

    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.AUTH
    assert "invalid x-api-key" in result.error.message


async def test_rate_limit_maps_to_typed_error(transport: CassetteTransport) -> None:
    result = await _provider(transport).complete(_request("PING_RATE_LIMIT"))

    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.RATE_LIMIT


async def test_empty_content_is_a_bad_response(transport: CassetteTransport) -> None:
    result = await _provider(transport).complete(_request("PING_MALFORMED"))

    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.BAD_RESPONSE


async def test_transport_failure_becomes_a_typed_error(transport: CassetteTransport) -> None:
    # No cassette entry matches this marker, so the transport raises; the
    # adapter must convert that into a typed TRANSPORT error, never let it
    # unwind the reasoning run (Core Architecture §8, failure as data).
    result = await _provider(transport).complete(_request("PING_NOT_RECORDED"))

    assert isinstance(result, Err)
    assert result.error.kind is LLMErrorKind.TRANSPORT


def test_cassette_transport_raises_on_unmatched_request() -> None:
    # The transport itself is loud about a missing fixture; it is the
    # adapter above that translates that into failure-as-data.
    empty = CassetteTransport(Cassette([]))
    with pytest.raises(TransportError):
        asyncio.run(empty.post_json(url="x", headers={}, payload={"k": "v"}))


class _CapturingTransport:
    """Records the last payload so we can assert the wire shape the adapter builds."""

    def __init__(self) -> None:
        self.last_payload: dict[str, JsonValue] | None = None
        self.last_headers: dict[str, str] | None = None

    async def post_json(
        self,
        *,
        url: str,
        headers: object,
        payload: object,
    ) -> HttpResponse:
        assert isinstance(payload, dict)
        assert isinstance(headers, dict)
        self.last_payload = payload
        self.last_headers = headers
        return HttpResponse(
            status_code=200,
            body={
                "content": [{"type": "text", "text": "ok"}],
                "model": "claude-sonnet-4-5",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "stop_reason": "end_turn",
            },
        )


async def test_request_payload_matches_the_messages_api_shape() -> None:
    capturing = _CapturingTransport()
    provider = AnthropicLLMProvider(
        transport=capturing, api_key="secret-key", model="claude-sonnet-4-5"
    )
    request = LLMRequest(
        model="claude-sonnet-4-5",
        system="system prompt",
        messages=(
            LLMMessage(
                role=Role.USER,
                content=(
                    TextBlock("describe this chart"),
                    ImageBlock(media_type="image/png", data_base64="ZmFrZQ=="),
                ),
            ),
        ),
        max_tokens=256,
        temperature=0.0,
    )

    await provider.complete(request)

    payload = capturing.last_payload
    assert payload is not None
    assert payload["model"] == "claude-sonnet-4-5"
    assert payload["max_tokens"] == 256
    assert payload["system"] == "system prompt"

    messages = payload["messages"]
    assert isinstance(messages, list)
    first_message = messages[0]
    assert isinstance(first_message, dict)
    content = first_message["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "describe this chart"}
    assert content[1] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "ZmFrZQ=="},
    }

    # The API key travels in the header, never in the body.
    assert capturing.last_headers is not None
    assert capturing.last_headers["x-api-key"] == "secret-key"
    assert capturing.last_headers["anthropic-version"] == "2023-06-01"
