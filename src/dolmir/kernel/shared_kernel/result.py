"""Explicit success/failure values for expected domain and business failures.

Expected failures (a risk limit exceeded, a symbol not recognized) are
modeled as values, never exceptions, so callers are forced to handle the
failure path (Core Architecture §16). Infrastructure failures remain real
exceptions, translated at adapter boundaries.

Deliberately minimal — no ``map``/``and_then`` combinator zoo. Python's
``match`` statement is the intended consumption pattern::

    match outcome:
        case Ok(value):
            ...
        case Err(error):
            ...
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["Err", "Ok", "Result"]


@dataclass(frozen=True, slots=True)
class Ok[T]:
    """A successful result carrying its value."""

    value: T

    __match_args__ = ("value",)

    def is_ok(self) -> bool:
        """Return ``True``; this is the success variant."""
        return True

    def is_err(self) -> bool:
        """Return ``False``; this is the success variant."""
        return False


@dataclass(frozen=True, slots=True)
class Err[E]:
    """A failed result carrying its error."""

    error: E

    __match_args__ = ("error",)

    def is_ok(self) -> bool:
        """Return ``False``; this is the failure variant."""
        return False

    def is_err(self) -> bool:
        """Return ``True``; this is the failure variant."""
        return True


type Result[T, E] = Ok[T] | Err[E]
