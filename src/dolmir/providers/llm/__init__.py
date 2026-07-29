"""LLMProviderPort + provider-agnostic DTOs, and the first adapter (Anthropic).

No vendor SDK type ever crosses this package boundary (EC §4): callers speak
``LLMRequest`` / ``LLMResponse``, and swapping providers is implementing one
port. The Anthropic adapter is split over an injected ``AsyncHttpTransport``
so it is contract-tested from cassettes with no network (roadmap Phase 2B).
"""

from dolmir.providers.llm.anthropic import AnthropicLLMProvider
from dolmir.providers.llm.cassette import Cassette, CassetteInteraction, CassetteTransport
from dolmir.providers.llm.fake import ScriptedLLMProvider, ScriptedReply
from dolmir.providers.llm.instrumentation import (
    CallRecord,
    CostBook,
    InstrumentedLLMProvider,
    ModelPricing,
    UsageLedger,
)
from dolmir.providers.llm.messages import (
    ContentBlock,
    ImageBlock,
    LLMError,
    LLMErrorKind,
    LLMMessage,
    LLMRequest,
    LLMResponse,
    Role,
    TextBlock,
    TokenUsage,
)
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.transport import (
    AsyncHttpTransport,
    HttpResponse,
    TransportError,
    UrllibHttpTransport,
)

__all__ = [
    "AnthropicLLMProvider",
    "AsyncHttpTransport",
    "CallRecord",
    "Cassette",
    "CassetteInteraction",
    "CassetteTransport",
    "ContentBlock",
    "CostBook",
    "HttpResponse",
    "ImageBlock",
    "InstrumentedLLMProvider",
    "LLMError",
    "LLMErrorKind",
    "LLMMessage",
    "LLMProviderPort",
    "LLMRequest",
    "LLMResponse",
    "ModelPricing",
    "Role",
    "ScriptedLLMProvider",
    "ScriptedReply",
    "TextBlock",
    "TokenUsage",
    "TransportError",
    "UrllibHttpTransport",
    "UsageLedger",
]
