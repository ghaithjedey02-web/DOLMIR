"""Opaque, immutable identity for domain entities."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

__all__ = ["EntityId"]


@dataclass(frozen=True, slots=True)
class EntityId:
    """A globally unique, immutable entity identifier.

    Wraps a UUID rather than exposing raw strings so identity is a distinct
    domain concept: two IDs compare by value, render stably, and cannot be
    accidentally swapped with arbitrary text.
    """

    value: uuid.UUID

    @classmethod
    def generate(cls) -> EntityId:
        """Create a new random identifier.

        This factory is the one sanctioned source of ID randomness; tests
        construct ``EntityId(uuid.UUID(...))`` directly for determinism.
        """
        return cls(uuid.uuid4())

    @classmethod
    def from_string(cls, raw: str) -> EntityId:
        """Parse an identifier from its canonical string form.

        Raises:
            ValueError: If ``raw`` is not a valid UUID string.
        """
        try:
            return cls(uuid.UUID(raw))
        except (ValueError, AttributeError, TypeError) as exc:
            msg = f"not a valid EntityId: {raw!r}"
            raise ValueError(msg) from exc

    def __str__(self) -> str:
        """Return the canonical string form."""
        return str(self.value)
