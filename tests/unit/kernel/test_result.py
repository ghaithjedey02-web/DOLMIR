import dataclasses

import pytest

from dolmir.kernel.shared_kernel import Err, Ok


def test_ok_carries_its_value() -> None:
    assert Ok(42).value == 42


def test_err_carries_its_error() -> None:
    assert Err("limit exceeded").error == "limit exceeded"


def test_ok_and_err_report_their_variant() -> None:
    assert Ok(1).is_ok()
    assert not Ok(1).is_err()
    assert Err("boom").is_err()
    assert not Err("boom").is_ok()


def test_results_are_immutable() -> None:
    ok: Ok[int] = Ok(1)
    err: Err[str] = Err("boom")
    with pytest.raises(dataclasses.FrozenInstanceError):
        ok.value = 2  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        err.error = "other"  # type: ignore[misc]


def test_results_compare_by_value() -> None:
    assert Ok(1) == Ok(1)
    assert Ok(1) != Ok(2)
    assert Err("a") == Err("a")
    ok_as_object: object = Ok(1)
    assert ok_as_object != Err(1)


def test_match_statement_destructures_both_variants() -> None:
    def describe(outcome: Ok[int] | Err[str]) -> str:
        match outcome:
            case Ok(value):
                return f"ok:{value}"
            case Err(error):
                return f"err:{error}"

    assert describe(Ok(7)) == "ok:7"
    assert describe(Err("nope")) == "err:nope"
