import pytest

from dolmir.kernel.shared_kernel import Symbol


def test_normalizes_case_and_whitespace() -> None:
    assert Symbol(" eurusd ").code == "EURUSD"


def test_slash_pairs_and_futures_codes_are_valid() -> None:
    assert Symbol("BTC/USD").code == "BTC/USD"
    assert Symbol("ES").code == "ES"
    assert Symbol("NAS100").code == "NAS100"


def test_equality_after_normalization() -> None:
    assert Symbol("eurusd") == Symbol("EURUSD")


def test_str_returns_normalized_code() -> None:
    assert str(Symbol("gbpusd")) == "GBPUSD"


@pytest.mark.parametrize("bad", ["", "   ", "/EURUSD", "EUR USD", "A" * 33, "eur$usd"])
def test_invalid_codes_are_rejected(bad: str) -> None:
    with pytest.raises(ValueError, match="invalid symbol code"):
        Symbol(bad)
