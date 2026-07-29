"""Shared plumbing between the trading LLM nodes.

Every trading agent does the same three things: build a request from the
run's accumulated state, call its provider, and turn the reply (or a
provider failure) into either parsed JSON or a typed ``NodeFailure`` the
graph routes around (Core Architecture §8, failure as data). That plumbing
lives here so the nodes stay about *judgment*, not transport.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.providers.llm.messages import LLMError, LLMErrorKind, LLMMessage, LLMRequest
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.structured import extract_json_object
from dolmir.providers.llm.transport import JsonValue

__all__ = [
    "complete_json",
    "complete_text",
    "object_list",
    "string_field",
    "string_list",
]


async def complete_text(
    provider: LLMProviderPort,
    *,
    system: str,
    user: str,
    node_name: str,
    max_tokens: int = 1024,
) -> Result[str, NodeFailure]:
    """Call ``provider`` with one user turn, returning its text or a failure."""
    request = LLMRequest(
        model=provider.model_id,
        system=system,
        messages=(LLMMessage.user_text(user),),
        max_tokens=max_tokens,
    )
    match await provider.complete(request):
        case Ok(response):
            return Ok(response.text)
        case Err(error):
            return Err(_node_failure(node_name, error))


async def complete_json(
    provider: LLMProviderPort,
    *,
    system: str,
    user: str,
    node_name: str,
    max_tokens: int = 1024,
) -> Result[dict[str, JsonValue], NodeFailure]:
    """Call ``provider`` and parse a JSON object out of the reply."""
    match await complete_text(
        provider, system=system, user=user, node_name=node_name, max_tokens=max_tokens
    ):
        case Ok(text):
            document = extract_json_object(text)
            if document is None:
                return Err(
                    NodeFailure(
                        node_name=node_name,
                        kind=FailureKind.EXTERNAL_ERROR,
                        message="model reply contained no parseable JSON object",
                    )
                )
            return Ok(document)
        case Err(failure):
            return Err(failure)


def _node_failure(node_name: str, error: LLMError) -> NodeFailure:
    """Translate a provider error into a node failure, preserving its kind."""
    kind = FailureKind.TIMEOUT if error.kind is LLMErrorKind.TIMEOUT else FailureKind.EXTERNAL_ERROR
    return NodeFailure(
        node_name=node_name, kind=kind, message=f"{error.kind.value}: {error.message}"
    )


def string_field(document: dict[str, JsonValue], key: str, default: str = "") -> str:
    """A trimmed string field, or ``default`` when absent/blank/non-string."""
    value = document.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def string_list(value: JsonValue) -> list[str]:
    """Coerce a JSON value into a list of non-empty strings."""
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def object_list(value: JsonValue) -> list[dict[str, JsonValue]]:
    """Coerce a JSON value into a list of objects, dropping non-objects."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]
