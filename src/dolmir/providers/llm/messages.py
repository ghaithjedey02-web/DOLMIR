"""Provider-agnostic LLM request/response DTOs.

These types are the *lingua franca* every agent speaks to every model: an
``LLMRequest`` goes in, a ``Result[LLMResponse, LLMError]`` comes out, and no
vendor SDK type ever crosses this boundary (Engineering Constitution §4).
Swapping Claude for another provider is implementing one port against these
same DTOs — the reasoning graph above never notices.

Everything here imports only the standard library: ``providers`` depend on
``kernel`` and nothing else in DOLMIR (enforced by import-linter).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

__all__ = [
    "ContentBlock",
    "ImageBlock",
    "LLMError",
    "LLMErrorKind",
    "LLMMessage",
    "LLMRequest",
    "LLMResponse",
    "Role",
    "TextBlock",
    "TokenUsage",
]

_ALLOWED_IMAGE_MEDIA_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})


class Role(enum.Enum):
    """Who authored a message in the conversation.

    The ``system`` prompt is deliberately *not* a role here: it is a
    top-level field on ``LLMRequest`` because that is how Claude (and most
    providers) model it — a standing instruction, not a turn.
    """

    USER = "user"
    ASSISTANT = "assistant"


@dataclass(frozen=True, slots=True)
class TextBlock:
    """A run of text within a message."""

    text: str

    def __post_init__(self) -> None:
        """Reject empty text blocks."""
        if not self.text.strip():
            msg = "TextBlock.text must be non-empty"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class ImageBlock:
    """A base64-encoded image within a message (multimodal input).

    ``media_type`` must be one the vision-capable providers accept;
    ``data_base64`` is the raw image bytes, base64-encoded — never a path or
    a URL, so a request is self-contained and a cassette can replay it
    byte-for-byte.
    """

    media_type: str
    data_base64: str

    def __post_init__(self) -> None:
        """Reject unsupported media types and empty payloads."""
        if self.media_type not in _ALLOWED_IMAGE_MEDIA_TYPES:
            allowed = ", ".join(sorted(_ALLOWED_IMAGE_MEDIA_TYPES))
            msg = f"ImageBlock.media_type {self.media_type!r} not supported; use one of: {allowed}"
            raise ValueError(msg)
        if not self.data_base64.strip():
            msg = "ImageBlock.data_base64 must be non-empty"
            raise ValueError(msg)


type ContentBlock = TextBlock | ImageBlock


@dataclass(frozen=True, kw_only=True, slots=True)
class LLMMessage:
    """One conversational turn: a role and its ordered content blocks."""

    role: Role
    content: tuple[ContentBlock, ...]

    def __post_init__(self) -> None:
        """Reject empty turns."""
        if not self.content:
            msg = "LLMMessage.content must contain at least one block"
            raise ValueError(msg)

    @classmethod
    def user_text(cls, text: str) -> LLMMessage:
        """Convenience constructor for a plain-text user turn."""
        return cls(role=Role.USER, content=(TextBlock(text),))


@dataclass(frozen=True, kw_only=True, slots=True)
class LLMRequest:
    """A complete, provider-agnostic model request.

    ``temperature`` defaults to ``0.0``: DOLMIR's reasoning stages favor the
    most reproducible output a model can give (a step toward the
    determinism the Cognitive Constitution prizes — full determinism is the
    deterministic stages' job, not the model's).
    """

    model: str
    messages: tuple[LLMMessage, ...]
    system: str | None = None
    max_tokens: int = 1024
    temperature: float = 0.0

    def __post_init__(self) -> None:
        """Reject malformed requests before they reach any provider."""
        if not self.model.strip():
            msg = "LLMRequest.model must be non-empty"
            raise ValueError(msg)
        if not self.messages:
            msg = "LLMRequest.messages must contain at least one message"
            raise ValueError(msg)
        if self.system is not None and not self.system.strip():
            msg = "LLMRequest.system, when given, must be non-empty"
            raise ValueError(msg)
        if self.max_tokens <= 0:
            msg = "LLMRequest.max_tokens must be positive"
            raise ValueError(msg)
        if not 0.0 <= self.temperature <= 1.0:
            msg = "LLMRequest.temperature must be within [0.0, 1.0]"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class TokenUsage:
    """Tokens consumed by one model call — the raw material of cost tracking."""

    input_tokens: int
    output_tokens: int

    def __post_init__(self) -> None:
        """Reject negative counts."""
        if self.input_tokens < 0 or self.output_tokens < 0:
            msg = "TokenUsage counts must be non-negative"
            raise ValueError(msg)

    @property
    def total_tokens(self) -> int:
        """Input plus output tokens."""
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True, kw_only=True, slots=True)
class LLMResponse:
    """A successful model completion, normalized across providers."""

    text: str
    usage: TokenUsage
    model: str
    stop_reason: str | None = None


class LLMErrorKind(enum.Enum):
    """Why a model call failed — coarse and provider-stable.

    Deliberately mirrors the vocabulary a graph node cares about: a
    ``TIMEOUT`` or ``RATE_LIMIT`` is a transient degradation a debate can
    survive; ``AUTH`` and ``INVALID_REQUEST`` are wiring bugs; ``BAD_RESPONSE``
    means the provider replied with something unparseable.
    """

    TIMEOUT = "timeout"
    TRANSPORT = "transport"
    RATE_LIMIT = "rate_limit"
    AUTH = "auth"
    INVALID_REQUEST = "invalid_request"
    BAD_RESPONSE = "bad_response"
    PROVIDER_ERROR = "provider_error"


@dataclass(frozen=True, kw_only=True, slots=True)
class LLMError:
    """A typed account of a failed model call (failure is data, EC §16)."""

    kind: LLMErrorKind
    message: str

    def __post_init__(self) -> None:
        """Reject unexplained errors."""
        if not self.message.strip():
            msg = "LLMError.message must be non-empty"
            raise ValueError(msg)
