import os

import pytest

from dolmir import __version__
from dolmir.delivery.cli.main import main


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if key.startswith("DOLMIR_"):
            monkeypatch.delenv(key)


def test_version_prints_the_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["version"])

    assert exit_code == 0
    assert __version__ in capsys.readouterr().out


def test_doctor_boots_with_zero_infrastructure(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["doctor", "--env-file", "/nonexistent/.env"])

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "config      OK" in out
    assert "event bus   OK" in out
    assert "plugins     OK" in out
    assert "dolmir doctor: OK" in out


def test_doctor_reports_allowlisted_but_missing_plugins(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DOLMIR_PLUGINS__ENABLED", '["ghost"]')

    exit_code = main(["doctor", "--env-file", "/nonexistent/.env"])

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "allowlisted plugin not installed: ghost" in out


def test_doctor_fails_loudly_on_invalid_configuration(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DOLMIR_ENVIRONMENT", "bogus")

    exit_code = main(["doctor", "--env-file", "/nonexistent/.env"])

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "FAIL" in captured.err
    assert "environment" in captured.err


def test_unknown_command_exits_nonzero() -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["not-a-command"])
    assert excinfo.value.code != 0
