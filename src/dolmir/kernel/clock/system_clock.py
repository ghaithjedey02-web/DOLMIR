"""Production clock adapter."""

from __future__ import annotations

from datetime import UTC, datetime

__all__ = ["SystemClock"]


class SystemClock:
    """Real wall-clock time, always UTC.

    This class is the single sanctioned call site of ``datetime.now`` in
    DOLMIR (Standing Rule 7). Everything else receives time through a
    ``ClockPort``.
    """

    def now(self) -> datetime:
        """Return the current wall-clock moment as an aware UTC datetime."""
        return datetime.now(UTC)
