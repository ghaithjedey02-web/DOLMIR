"""Deterministic clock for tests and, later, replayed history."""

from __future__ import annotations

from datetime import datetime, timedelta

__all__ = ["FixedClock"]


class FixedClock:
    """A clock frozen at a chosen moment, advanced only explicitly.

    Lives in the package rather than in test code because determinism over
    time is a product capability, not just a test convenience: Phase 7's
    backtesting builds on the same idea (Core Architecture §7).
    """

    def __init__(self, moment: datetime) -> None:
        """Freeze the clock at ``moment``.

        Raises:
            ValueError: If ``moment`` is naive; clocks only speak
                timezone-aware time.
        """
        if moment.tzinfo is None:
            msg = "FixedClock requires a timezone-aware datetime"
            raise ValueError(msg)
        self._moment = moment

    def now(self) -> datetime:
        """Return the frozen moment."""
        return self._moment

    def advance(self, delta: timedelta) -> None:
        """Move the frozen moment forward (or backward) by ``delta``."""
        self._moment = self._moment + delta

    def set_to(self, moment: datetime) -> None:
        """Re-freeze the clock at a new moment.

        Raises:
            ValueError: If ``moment`` is naive.
        """
        if moment.tzinfo is None:
            msg = "FixedClock requires a timezone-aware datetime"
            raise ValueError(msg)
        self._moment = moment
