"""Structural validation of the provider-agnostic DTOs."""

from __future__ import annotations

import pytest

from dolmir.providers.llm import (
    ImageBlock,
    LLMError,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    Role,
    TextBlock,
    TokenUsage,
)


def test_text_block_rejects_empty() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        TextBlock("   ")


def test_image_block_rejects_unsupported_media_type() -> None:
    with pytest.raises(ValueError, match="not supported"):
        ImageBlock(media_type="image/tiff", data_base64="abc")


def test_image_block_rejects_empty_data() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        ImageBlock(media_type="image/png", data_base64="")


def test_message_rejects_empty_content() -> None:
    with pytest.raises(ValueError, match="at least one block"):
        LLMMessage(role=Role.USER, content=())


def test_user_text_convenience_builds_a_user_turn() -> None:
    message = LLMMessage.user_text("hello")
    assert message.role is Role.USER
    assert message.content == (TextBlock("hello"),)


@pytest.mark.parametrize(
    ("field", "value"),
    [("max_tokens", 0), ("max_tokens", -1), ("temperature", -0.1), ("temperature", 1.1)],
)
def test_request_rejects_out_of_range(field: str, value: float) -> None:
    kwargs: dict[str, object] = {
        "model": "m",
        "messages": (LLMMessage.user_text("hi"),),
        field: value,
    }
    with pytest.raises(ValueError, match=field.split("_", maxsplit=1)[0]):
        LLMRequest(**kwargs)  # type: ignore[arg-type]


def test_request_rejects_blank_system() -> None:
    with pytest.raises(ValueError, match="system"):
        LLMRequest(model="m", messages=(LLMMessage.user_text("hi"),), system="  ")


def test_token_usage_totals_and_rejects_negative() -> None:
    assert TokenUsage(input_tokens=10, output_tokens=5).total_tokens == 15
    with pytest.raises(ValueError, match="non-negative"):
        TokenUsage(input_tokens=-1, output_tokens=0)


def test_error_rejects_blank_message() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        LLMError(kind=LLMErrorKind.TRANSPORT, message="")
