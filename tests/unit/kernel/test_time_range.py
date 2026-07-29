from datetime import UTC, datetime, timedelta

import pytest

from dolmir.kernel.shared_kernel import TimeRange

_T0 = datetime(2026, 7, 9, 8, 0, tzinfo=UTC)
_T1 = datetime(2026, 7, 9, 12, 0, tzinfo=UTC)
_T2 = datetime(2026, 7, 9, 16, 0, tzinfo=UTC)


def test_duration() -> None:
    assert TimeRange(_T0, _T1).duration == timedelta(hours=4)


def test_end_before_start_is_rejected() -> None:
    with pytest.raises(ValueError, match="precedes start"):
        TimeRange(_T1, _T0)


def test_naive_bounds_are_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        TimeRange(datetime(2026, 7, 9, 8, 0), _T1)


def test_contains_is_half_open() -> None:
    session = TimeRange(_T0, _T1)
    assert session.contains(_T0)  # start inclusive
    assert not session.contains(_T1)  # end exclusive
    assert session.contains(_T0 + timedelta(hours=1))


def test_contains_rejects_naive_moment() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        TimeRange(_T0, _T1).contains(datetime(2026, 7, 9, 9, 0))


def test_adjacent_ranges_do_not_overlap() -> None:
    assert not TimeRange(_T0, _T1).overlaps(TimeRange(_T1, _T2))


def test_overlapping_ranges_overlap_symmetrically() -> None:
    a = TimeRange(_T0, _T2)
    b = TimeRange(_T1, _T2)
    assert a.overlaps(b)
    assert b.overlaps(a)
