"""Clock port and adapters (Standing Rule 7: time is always injected)."""

from dolmir.kernel.clock.fixed_clock import FixedClock
from dolmir.kernel.clock.port import ClockPort
from dolmir.kernel.clock.system_clock import SystemClock

__all__ = ["ClockPort", "FixedClock", "SystemClock"]
