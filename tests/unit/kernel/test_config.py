import os
from pathlib import Path

import pytest

from dolmir.kernel.config import DolmirSettings, InvalidConfigurationError, load_settings


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip ambient DOLMIR_* variables so each test controls its inputs."""
    for key in list(os.environ):
        if key.startswith("DOLMIR_"):
            monkeypatch.delenv(key)


def test_defaults_load_with_no_environment() -> None:
    settings = load_settings(env_file=None)
    assert settings.environment == "dev"
    assert settings.log_level == "INFO"
    assert settings.plugins.enabled == ()


def test_environment_variables_override_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOLMIR_LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("DOLMIR_ENVIRONMENT", "prod")
    settings = load_settings(env_file=None)
    assert settings.log_level == "DEBUG"
    assert settings.environment == "prod"


def test_nested_plugin_allowlist_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOLMIR_PLUGINS__ENABLED", '["alpha","beta"]')
    settings = load_settings(env_file=None)
    assert settings.plugins.enabled == ("alpha", "beta")


def test_invalid_value_fails_loudly_with_the_field_named(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOLMIR_ENVIRONMENT", "bogus")
    with pytest.raises(InvalidConfigurationError, match="environment"):
        load_settings(env_file=None)


def test_unknown_dolmir_variable_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOLMIR_TYPO_FIELD", "1")
    with pytest.raises(InvalidConfigurationError, match="DOLMIR_TYPO_FIELD"):
        load_settings(env_file=None)


def test_misspelled_known_variable_is_rejected_not_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOLMIR_LOG_LEVL", "DEBUG")  # typo of LOG_LEVEL
    with pytest.raises(InvalidConfigurationError, match="DOLMIR_LOG_LEVL"):
        load_settings(env_file=None)


def test_settings_are_immutable() -> None:
    settings = load_settings(env_file=None)
    with pytest.raises(Exception, match="frozen"):
        settings.log_level = "DEBUG"  # type: ignore[misc]


def test_dotenv_file_is_layered_beneath_process_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("DOLMIR_LOG_LEVEL=WARNING\n")
    settings = load_settings(env_file=env_file)
    assert settings.log_level == "WARNING"

    monkeypatch.setenv("DOLMIR_LOG_LEVEL", "ERROR")
    overridden = load_settings(env_file=env_file)
    assert overridden.log_level == "ERROR", "process env must win over the dotenv file"


def test_direct_construction_is_equivalent_for_defaults() -> None:
    assert DolmirSettings(_env_file=None) == load_settings(env_file=None)
