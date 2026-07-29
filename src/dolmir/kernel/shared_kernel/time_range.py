"""Half-open time interval."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

__all__ = ["TimeRange"]


@dataclass(frozen=True, slots=True)
class TimeRange:
    """An immutable half-open interval ``[start, end)``.

    Half-open by convention so adjacent ranges tile without overlap —
    session and kill-zone arithmetic depends on that property. Both bounds
    must be timezone-aware: a trading system that mixes naive and aware
    datetimes will mis-assign sessions, so naive datetimes are rejected at
    the boundary rather than tolerated.
    """

    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        """Validate awareness and ordering of the bounds."""
        if self.start.tzinfo is None or self.end.tzinfo is None:
            msg = "TimeRange bounds must be timezone-aware datetimes"
            raise ValueError(msg)
        if self.end < self.start:
            msg = (
                f"TimeRange end ({self.end.isoformat()}) precedes start ({self.start.isoformat()})"
            )
            raise ValueError(msg)

    @property
    def duration(self) -> timedelta:
        """Length of the interval."""
        return self.end - self.start

    def contains(self, moment: datetime) -> bool:
        """Return whether ``moment`` falls inside ``[start, end)``.

        Raises:
            ValueError: If ``moment`` is naive.
        """
        if moment.tzinfo is None:
            msg = "TimeRange.contains requires a timezone-aware datetime"
            raise ValueError(msg)
        return self.start <= moment < self.end

    def overlaps(self, other: TimeRange) -> bool:
        """Return whether this interval and ``other`` share any instant."""
        return self.start < other.end and other.start < self.end
