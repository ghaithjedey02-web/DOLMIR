"""Allowlist-enforced plugin registration (Standing Rule 9)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import structlog

from dolmir.kernel.plugin_system.context import PluginContext
from dolmir.kernel.plugin_system.plugin import Plugin

__all__ = ["PluginRegistrationError", "PluginRegistry", "RegistrationReport"]

_logger = structlog.get_logger(__name__)


class PluginRegistrationError(Exception):
    """Raised when boot-time plugin registration cannot proceed safely.

    Registration failures are startup failures: fail fast and loud
    (Core Architecture §16), never boot with a half-registered plugin.
    """


@dataclass(frozen=True, slots=True)
class RegistrationReport:
    """Outcome of one registration pass, for boot diagnostics."""

    registered: tuple[str, ...] = field(default=())
    skipped_not_allowlisted: tuple[str, ...] = field(default=())
    allowlisted_but_absent: tuple[str, ...] = field(default=())


class PluginRegistry:
    """Registers candidate plugins against an explicit allowlist.

    Discovery is deliberately not this class's job: in V1 the composition
    root passes an explicit candidate list. ``entry_points``-based discovery
    (a later phase, CA §13) will feed the same registry — the allowlist
    check is what must never be bypassed, regardless of how candidates are
    found. Auto-load-everything-installed is a supply-chain risk this
    project has rejected in writing (Standing Rule 9).
    """

    def __init__(self, allowlist: Sequence[str]) -> None:
        """Create a registry enforcing ``allowlist`` (plugin names)."""
        self._allowlist = tuple(allowlist)

    def register_all(
        self, candidates: Sequence[Plugin], context: PluginContext
    ) -> RegistrationReport:
        """Register every allowlisted candidate; skip the rest, loudly.

        Args:
            candidates: Plugins available in this process.
            context: The capability surface handed to each plugin.

        Returns:
            A report of what was registered, skipped, and missing.

        Raises:
            PluginRegistrationError: On duplicate plugin names, or if an
                allowlisted plugin's ``register`` raises — a broken plugin
                is a boot failure, not a warning.
        """
        seen: set[str] = set()
        registered: list[str] = []
        skipped: list[str] = []

        for plugin in candidates:
            name = plugin.metadata.name
            if name in seen:
                msg = f"duplicate plugin name {name!r}: plugin names must be unique"
                raise PluginRegistrationError(msg)
            seen.add(name)

            if name not in self._allowlist:
                _logger.warning(
                    "plugin skipped: not in the configured allowlist (DOLMIR_PLUGINS__ENABLED)",
                    plugin=name,
                    version=plugin.metadata.version,
                )
                skipped.append(name)
                continue

            try:
                plugin.register(context)
            except Exception as exc:
                msg = f"plugin {name!r} failed during register(): {exc}"
                raise PluginRegistrationError(msg) from exc
            _logger.info(
                "plugin registered",
                plugin=name,
                version=plugin.metadata.version,
            )
            registered.append(name)

        absent = tuple(name for name in self._allowlist if name not in seen)
        for name in absent:
            _logger.warning(
                "allowlisted plugin not present in this installation",
                plugin=name,
            )

        return RegistrationReport(
            registered=tuple(registered),
            skipped_not_allowlisted=tuple(skipped),
            allowlisted_but_absent=absent,
        )
