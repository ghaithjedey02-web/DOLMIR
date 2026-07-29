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

__all__ = [
    "DolmirSettings",
    "LLMSettings",
    "PersistenceSettings",
    "PluginSettings",
    "RiskSettings",
]


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


class LLMSettings(BaseModel):
    """LLM provider configuration (Core Architecture §10).

    ``api_key`` is a secret: it is read only through this validated schema,
    from ``DOLMIR_LLM__API_KEY``, never from ``os.environ`` elsewhere. It
    defaults to ``None`` so the kernel boots without a key (``doctor``, tests);
    the ``analyze`` command fails loudly and legibly if it is missing when a
    live run is attempted.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: Literal["anthropic"] = Field(
        default="anthropic",
        description="Which LLM adapter powers the agents. Anthropic is the V1 adapter.",
    )
    api_key: str | None = Field(
        default=None,
        description="LLM API key (secret; env-only, DOLMIR_LLM__API_KEY).",
    )
    model: str = Field(
        default="claude-sonnet-4-5",
        description="Model id every agent role uses (per-role selection arrives later).",
    )
    base_url: str = Field(
        default="https://api.anthropic.com/v1/messages",
        description="Provider endpoint (override for a proxy or gateway).",
    )
    max_tokens: int = Field(default=1024, gt=0, description="Maximum output tokens per model call.")
    timeout_seconds: float = Field(
        default=60.0, gt=0.0, description="Per-request HTTP timeout in seconds."
    )


class RiskSettings(BaseModel):
    """Standing risk limits the deterministic Risk Gate enforces."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    max_risk_fraction_per_trade: float = Field(
        default=0.01,
        gt=0.0,
        le=1.0,
        description="Largest fraction of equity riskable on one trade (0.01 = 1%).",
    )
    min_reward_to_risk: float = Field(
        default=1.5, gt=0.0, description="Smallest acceptable reward-to-risk ratio."
    )


class PersistenceSettings(BaseModel):
    """Local-first storage locations (Core Architecture §11, EC §9)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    trace_db_path: str = Field(
        default="dolmir.sqlite3",
        description="SQLite file where reasoning traces are persisted.",
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
    llm: LLMSettings = Field(
        default_factory=LLMSettings,
        description="LLM provider configuration (agents; DOLMIR_LLM__*).",
    )
    risk: RiskSettings = Field(
        default_factory=RiskSettings,
        description="Standing risk limits for the Risk Gate (DOLMIR_RISK__*).",
    )
    persistence: PersistenceSettings = Field(
        default_factory=PersistenceSettings,
        description="Local storage locations (DOLMIR_PERSISTENCE__*).",
    )
