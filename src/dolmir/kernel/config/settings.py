"""The strongly-typed configuration schema.

Layered configuration (Core Architecture §10): versioned defaults here →
environment overrides (``.env`` / ``DOLMIR_*`` env vars) → runtime
overrides (CLI flags). Validated once, at boot, as a whole — a bad
configuration fails loudly before anything runs, never three layers deep at
runtime.

Composition pattern: each future Engine/Provider contributes its own
sub-model (as ``PluginSettings`` does below) rather than growing one flat
namespace, so adding an engine never means editing unrelated config.
Nested fields map to ``DOLMIR_<SECTION>__<FIELD>`` environment variables.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = ["DolmirSettings", "PluginSettings"]


class PluginSettings(BaseModel):
    """Plugin subsystem configuration.

    ``enabled`` is the explicit allowlist (Standing Rule 9): a plugin not
    named here is never registered, no matter what is installed. There is
    deliberately no "enable all" switch.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    enabled: tuple[str, ...] = Field(
        default=(),
        description="Names of plugins allowed to register. Empty means none.",
    )


class DolmirSettings(BaseSettings):
    """Root settings object — the single validated view of all configuration.

    Secrets (LLM API keys, later) enter exclusively as environment
    variables through this schema; no code outside ``dolmir.kernel.config``
    reads ``os.environ`` (Core Architecture §10).
    """

    model_config = SettingsConfigDict(
        env_prefix="DOLMIR_",
        env_nested_delimiter="__",
        frozen=True,
        extra="forbid",
        case_sensitive=False,
    )

    environment: Literal["dev", "test", "prod"] = Field(
        default="dev",
        description="Deployment environment; controls log rendering among other things.",
    )
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field(
        default="INFO",
        description="Minimum level for structured logs.",
    )
    plugins: PluginSettings = Field(
        default_factory=PluginSettings,
        description="Plugin subsystem configuration.",
    )
