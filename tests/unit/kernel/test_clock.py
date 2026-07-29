from datetime import UTC, datetime, timedelta

import pytest

from dolmir.kernel.clock import ClockPort, FixedClock, SystemClock

_MOMENT = datetime(2026, 7, 9, 12, 0, tzinfo=UTC)


def test_system_clock_returns_aware_utc() -> None:
    now = SystemClock().now()
    assert now.tzinfo is UTC


def test_system_clock_does_not_go_backwards() -> None:
    clock = SystemClock()
    assert clock.now() <= clock.now()


def test_fixed_clock_returns_the_frozen_moment() -> None:
    assert FixedClock(_MOMENT).now() == _MOMENT


def test_fixed_clock_advance() -> None:
    clock = FixedClock(_MOMENT)
    clock.advance(timedelta(minutes=30))
    assert clock.now() == _MOMENT + timedelta(minutes=30)


def test_fixed_clock_set_to() -> None:
    clock = FixedClock(_MOMENT)
    later = _MOMENT + timedelta(days=1)
    clock.set_to(later)
    assert clock.now() == later


def test_fixed_clock_rejects_naive_datetimes() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        FixedClock(datetime(2026, 7, 9, 12, 0))
    clock = FixedClock(_MOMENT)
    with pytest.raises(ValueError, match="timezone-aware"):
        clock.set_to(datetime(2026, 7, 9, 12, 0))


def test_both_adapters_satisfy_the_port() -> None:
    clocks: list[ClockPort] = [SystemClock(), FixedClock(_MOMENT)]
    for clock in clocks:
        assert clock.now().tzinfo is not None
