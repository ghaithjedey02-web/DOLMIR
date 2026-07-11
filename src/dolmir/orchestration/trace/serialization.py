"""The serializability contract: every reasoning object renders to JSON.

``to_document`` deterministically converts any reasoning object — frozen
dataclasses composed of enums, ``EntityId``s, datetimes, tuples, and
frozensets — into plain JSON-compatible structures. Persisted objects'
``schema_version`` (Standing Rule 6) is included in the document so future
upcasters can migrate old records.

This module is a *contract*, not storage: deserialization and the
upcaster/migration registry belong to the persistence adapters that first
write records to disk (Phase 2B onward, Docs/ROADMAP.md). Unknown types
fail loudly (Core Architecture §16) — a silently-lossy serializer would
corrupt years of trace history.
"""

from __future__ import annotations

import dataclasses
import enum
import uuid
from datetime import datetime

from dolmir.kernel.shared_kernel import EntityId

__all__ = ["JsonValue", "to_document"]

type JsonValue = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


def to_document(obj: object) -> JsonValue:  # noqa: PLR0911 — a type dispatcher is clearest with one return per handled type
    """Convert a reasoning object into a JSON-compatible document.

    Conversion rules, applied recursively:

    - dataclasses → ``dict`` of their fields, plus ``"schema_version"``
      when the class declares one (Standing Rule 6) and ``"_type"`` with
      the class name, so documents are self-describing for future
      upcasters;
    - ``EntityId``/``UUID`` → canonical string;
    - ``datetime`` → ISO-8601 string (always timezone-aware upstream);
    - ``Enum`` → its value;
    - ``tuple``/``list`` → ``list``; ``frozenset``/``set`` → sorted
      ``list`` (deterministic output for stable diffs and hashes);
    - ``str``/``int``/``float``/``bool``/``None`` → unchanged.

    Raises:
        TypeError: For any type outside these rules — loudly, never lossily.
    """
    if obj is None or isinstance(obj, str | int | float | bool):
        return obj
    if isinstance(obj, EntityId):
        return str(obj)
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, enum.Enum):
        return to_document(obj.value)
    if isinstance(obj, tuple | list):
        return [to_document(item) for item in obj]
    if isinstance(obj, frozenset | set):
        converted = [to_document(item) for item in obj]
        return sorted(converted, key=repr)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        document: dict[str, JsonValue] = {"_type": type(obj).__name__}
        schema_version = getattr(type(obj), "schema_version", None)
        if isinstance(schema_version, int):
            document["schema_version"] = schema_version
        for field in dataclasses.fields(obj):
            document[field.name] = to_document(getattr(obj, field.name))
        return document
    msg = (
        f"cannot serialize {type(obj).__name__}: reasoning objects are "
        "dataclasses of enums, ids, datetimes, and containers — extend "
        "to_document deliberately rather than letting data slip through"
    )
    raise TypeError(msg)
