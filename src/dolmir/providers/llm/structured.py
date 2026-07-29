"""Parsing structured data out of free-form model text.

Phase 2B asks models for JSON in their prose ("prompted JSON") rather than
using a provider's native structured-output mode, so the parsing is one
place and provider-agnostic. Models wrap JSON in code fences or surround it
with commentary; ``extract_json_object`` finds the first balanced ``{...}``
object, tolerant of both. It lives in ``providers`` so the vision adapter
(``providers`` can import ``providers``) and the trading agents
(``orchestration`` can import ``providers``) share one implementation.
"""

from __future__ import annotations

import json

from dolmir.providers.llm.transport import JsonValue

__all__ = ["extract_json_object"]


def extract_json_object(text: str) -> dict[str, JsonValue] | None:
    """Return the first balanced top-level JSON object in ``text``.

    Returns ``None`` when no parseable object is present — callers turn that
    into a typed ``BAD_RESPONSE``-style failure rather than guessing, so a
    malformed model reply never silently becomes empty structured data.
    """
    span = _first_object_span(text)
    if span is None:
        return None
    start, end = span
    try:
        parsed = json.loads(text[start:end])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _first_object_span(text: str) -> tuple[int, int] | None:
    """Index span of the first balanced ``{...}``, respecting string literals."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return start, index + 1
    return None
