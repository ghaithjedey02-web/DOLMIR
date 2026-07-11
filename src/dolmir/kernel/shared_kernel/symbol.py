"""Tradeable instrument identifier."""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["Symbol"]

_SYMBOL_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._/-]{0,31}$")


@dataclass(frozen=True, slots=True)
class Symbol:
    """A normalized instrument code such as ``EURUSD``, ``BTC/USD`` or ``ES``.

    Normalization (uppercase, surrounding whitespace stripped) happens at
    construction so two references to the same instrument always compare
    equal. Venue- or vendor-specific richer identity (exchange, contract
    month, strike/expiry) belongs to the owning engine's own types with a
    mapper at its boundary — not to this shared type (Core Architecture §5,
    shared-kernel change control).
    """

    code: str

    def __post_init__(self) -> None:
        """Normalize and validate the code."""
        normalized = self.code.strip().upper()
        if not _SYMBOL_PATTERN.match(normalized):
            msg = (
                f"invalid symbol code {self.code!r}: must be 1-32 characters of "
                "A-Z, 0-9, '.', '_', '/' or '-', starting alphanumeric"
            )
            raise ValueError(msg)
        object.__setattr__(self, "code", normalized)

    def __str__(self) -> str:
        """Return the normalized code."""
        return self.code
