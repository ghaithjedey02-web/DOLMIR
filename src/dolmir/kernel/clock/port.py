"""Time as an injected capability.

``datetime.now()`` is banned in domain and application code (Standing
Rule 7): every component that needs the current time receives a
``ClockPort``. This single discipline is what makes deterministic tests and
future backtesting (a ``ReplayClock``, Phase 7) possible without rewriting
any engine.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

__all__ = ["ClockPort"]


class ClockPort(Protocol):
    """Source of the current moment.

    Contract: ``now()`` returns a timezone-aware datetime in UTC. Naive
    datetimes never enter the system through a clock.
    """

    def now(self) -> datetime:
        """Return the current moment as an aware UTC datetime."""
        ...
