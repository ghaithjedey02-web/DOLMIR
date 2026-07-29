"""Cassette transport: replay recorded HTTP exchanges, offline.

A cassette is a list of recorded ``(match, status, body)`` interactions.
The ``CassetteTransport`` implements ``AsyncHttpTransport`` by returning the
first interaction whose ``match`` string occurs in the JSON-serialized
request payload — so the *real* ``AnthropicLLMProvider`` can be contract-
tested end to end (payload building, status handling, response parsing) with
no API key and no network. Recording a live call to produce new cassettes is
a developer task done with a real key; the committed cassettes are then the
deterministic CI fixture (roadmap Phase 2B).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from dolmir.providers.llm.transport import HttpResponse, JsonValue, TransportError

__all__ = ["Cassette", "CassetteInteraction", "CassetteTransport"]


@dataclass(frozen=True, kw_only=True, slots=True)
class CassetteInteraction:
    """One recorded request→response exchange.

    ``match`` is a substring expected in the serialized request payload
    (e.g. a model id or a distinctive prompt fragment); ``status_code`` and
    ``body`` are the recorded response.
    """

    match: str
    status_code: int
    body: JsonValue

    def matches(self, rendered_payload: str) -> bool:
        """Whether this interaction should answer ``rendered_payload``."""
        return self.match in rendered_payload

    def as_response(self) -> HttpResponse:
        """The recorded response as an ``HttpResponse``."""
        return HttpResponse(status_code=self.status_code, body=self.body)


class Cassette:
    """An ordered set of recorded interactions, loadable from JSON."""

    def __init__(self, interactions: Sequence[CassetteInteraction]) -> None:
        """Wrap the recorded ``interactions``."""
        self._interactions = tuple(interactions)

    @property
    def interactions(self) -> tuple[CassetteInteraction, ...]:
        """The recorded interactions."""
        return self._interactions

    @classmethod
    def from_file(cls, path: Path | str) -> Cassette:
        """Load a cassette from a JSON file (a list of interaction objects)."""
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            msg = f"cassette {path} must be a JSON list of interactions"
            raise ValueError(msg)
        interactions = [cls._interaction_from(entry) for entry in raw]
        return cls(interactions)

    @staticmethod
    def _interaction_from(entry: object) -> CassetteInteraction:
        """Build one interaction from a decoded JSON object."""
        if not isinstance(entry, dict):
            msg = "each cassette interaction must be a JSON object"
            raise ValueError(msg)
        match = entry.get("match")
        status = entry.get("status_code")
        if not isinstance(match, str) or not isinstance(status, int):
            msg = "cassette interaction requires string 'match' and int 'status_code'"
            raise ValueError(msg)
        return CassetteInteraction(
            match=match, status_code=status, body=cast("JsonValue", entry.get("body"))
        )


class CassetteTransport:
    """An ``AsyncHttpTransport`` that answers from a cassette."""

    def __init__(self, cassette: Cassette) -> None:
        """Replay ``cassette``."""
        self._cassette = cassette

    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, JsonValue],
    ) -> HttpResponse:
        """Return the first cassette interaction matching ``payload``.

        Raises:
            TransportError: If no recorded interaction matches — a missing
                cassette entry is a test-fixture gap, surfaced loudly rather
                than silently returning an empty response.
        """
        rendered = json.dumps(payload, sort_keys=True)
        for interaction in self._cassette.interactions:
            if interaction.matches(rendered):
                return interaction.as_response()
        msg = f"no cassette interaction matched request to {url}"
        raise TransportError(msg)
