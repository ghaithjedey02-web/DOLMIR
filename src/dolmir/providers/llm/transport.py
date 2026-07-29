"""The HTTP transport seam beneath the LLM adapters.

Splitting transport from the provider is what makes the provider offline-
testable: the ``AnthropicLLMProvider`` becomes pure request-building and
response-parsing logic over an injected ``AsyncHttpTransport``, so a
cassette can replay a recorded exchange with zero network and zero API key
(the roadmap's "cassette-based contract test suite"). The real transport
below uses only the standard library — no third-party HTTP dependency
enters the tree for this.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, cast, runtime_checkable

__all__ = [
    "AsyncHttpTransport",
    "HttpResponse",
    "JsonValue",
    "TransportError",
    "UrllibHttpTransport",
]

type JsonValue = bool | int | float | str | list[JsonValue] | dict[str, JsonValue] | None


class TransportError(Exception):
    """The request never produced an HTTP response (network/DNS/timeout).

    A non-2xx *response* is not a ``TransportError`` — it is a valid
    ``HttpResponse`` the provider adapter inspects and maps to a typed
    ``LLMError``. This exception is only for "the exchange did not happen".
    """


@dataclass(frozen=True, kw_only=True, slots=True)
class HttpResponse:
    """A minimal HTTP response: status plus already-parsed JSON body."""

    status_code: int
    body: JsonValue


@runtime_checkable
class AsyncHttpTransport(Protocol):
    """Posts a JSON payload and returns a JSON response."""

    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, JsonValue],
    ) -> HttpResponse:
        """POST ``payload`` as JSON to ``url``.

        Raises:
            TransportError: If no HTTP response is obtained at all.
        """
        ...


class UrllibHttpTransport:
    """Standard-library transport — the production default, zero new deps.

    The blocking ``urllib`` call runs in a worker thread so the coroutine
    interface holds without pulling in an async HTTP library. This is the
    real network path ``dolmir analyze`` takes when an API key is present;
    tests never exercise it (they inject a cassette transport instead).
    """

    def __init__(self, *, timeout_seconds: float = 60.0) -> None:
        """Configure the request timeout applied to every call."""
        self._timeout = timeout_seconds

    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, JsonValue],
    ) -> HttpResponse:
        """POST ``payload`` to ``url`` from a worker thread."""
        return await asyncio.to_thread(self._post_sync, url, dict(headers), dict(payload))

    def _post_sync(
        self, url: str, headers: dict[str, str], payload: Mapping[str, JsonValue]
    ) -> HttpResponse:
        """Blocking POST; HTTP errors become responses, network errors raise."""
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url, data=data, headers={**headers, "content-type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return HttpResponse(
                    status_code=response.status,
                    body=self._decode(response.read()),
                )
        except urllib.error.HTTPError as exc:
            # A 4xx/5xx is a real response the adapter must inspect, not a
            # transport failure — read its body and hand it back.
            return HttpResponse(status_code=exc.code, body=self._decode(exc.read()))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            msg = f"HTTP POST to {url} failed before a response: {exc}"
            raise TransportError(msg) from exc

    @staticmethod
    def _decode(raw: bytes) -> JsonValue:
        """Parse a response body as JSON, or ``None`` for an empty body."""
        if not raw:
            return None
        return cast("JsonValue", json.loads(raw))
