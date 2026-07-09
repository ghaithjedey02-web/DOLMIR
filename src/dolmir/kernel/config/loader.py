"""Fail-fast settings loading with boundary error translation.

This module is the single sanctioned reader of ``os.environ`` in DOLMIR
(Core Architecture §10).
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, ValidationError

from dolmir.kernel.config.settings import DolmirSettings

__all__ = ["InvalidConfigurationError", "load_settings"]

_ENV_PREFIX = "DOLMIR_"
_NESTED_DELIMITER = "__"


class InvalidConfigurationError(Exception):
    """Raised when configuration is missing, malformed, or contradictory.

    Carries a human-readable, multi-line description of every problem found
    so a misconfiguration is diagnosable from the error alone. This is the
    adapter-boundary translation required by Core Architecture §16: pydantic
    is an implementation detail of this package; its ``ValidationError``
    never crosses into the rest of the system.
    """


def _known_env_keys(model: type[BaseModel], prefix: str) -> set[str]:
    """Every environment variable name the settings schema can consume.

    A nested model field is addressable both whole (``DOLMIR_PLUGINS`` as
    JSON) and per-subfield (``DOLMIR_PLUGINS__ENABLED``), so both spellings
    are returned.
    """
    keys: set[str] = set()
    for name, field in model.model_fields.items():
        key = f"{prefix}{name}".upper()
        keys.add(key)
        annotation = field.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            keys |= _known_env_keys(annotation, prefix=f"{key}{_NESTED_DELIMITER}")
    return keys


def _reject_unknown_env_vars() -> None:
    """Fail loudly on ``DOLMIR_*`` variables the schema cannot consume.

    pydantic-settings silently ignores environment variables that match no
    declared field — which would turn a typo (``DOLMIR_LOG_LEVL``) into a
    silently applied default. Silent misconfiguration is exactly what Core
    Architecture §10 forbids, so unknown prefixed variables are a boot
    failure here.
    """
    known = _known_env_keys(DolmirSettings, prefix=_ENV_PREFIX)
    unknown = sorted(
        key
        for key in os.environ
        if key.upper().startswith(_ENV_PREFIX) and key.upper() not in known
    )
    if unknown:
        listing = "\n".join(f"  - {key}" for key in unknown)
        valid = "\n".join(f"  - {key}" for key in sorted(known))
        msg = (
            f"invalid DOLMIR configuration: unknown environment variable(s):\n{listing}\n"
            f"Recognized variables are:\n{valid}"
        )
        raise InvalidConfigurationError(msg)


def load_settings(env_file: Path | str | None = ".env") -> DolmirSettings:
    """Build and validate the complete settings object.

    Args:
        env_file: Optional dotenv file layered beneath process environment
            variables (env vars win). Pass ``None`` to read only the
            process environment — tests do this for isolation.

    Returns:
        The immutable, validated settings.

    Raises:
        InvalidConfigurationError: If any value is invalid or an unknown
            ``DOLMIR_``-prefixed variable is present. Fails at boot, loudly,
            with every problem listed (Core Architecture §10/§16).
    """
    _reject_unknown_env_vars()
    try:
        return DolmirSettings(_env_file=env_file)
    except ValidationError as exc:
        problems = "\n".join(
            f"  - {'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        msg = (
            f"invalid DOLMIR configuration ({exc.error_count()} problem(s)):\n{problems}\n"
            "Configuration comes from DOLMIR_* environment variables "
            "(nested fields use '__', e.g. DOLMIR_PLUGINS__ENABLED) "
            f"and the dotenv file {env_file!r}."
        )
        raise InvalidConfigurationError(msg) from exc
