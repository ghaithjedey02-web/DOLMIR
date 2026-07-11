"""The plugin contract (Core Architecture §13)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from dolmir.kernel.plugin_system.context import PluginContext

__all__ = ["Plugin", "PluginMetadata"]


@dataclass(frozen=True, slots=True)
class PluginMetadata:
    """Identity a plugin declares about itself."""

    name: str
    version: str
    description: str

    def __post_init__(self) -> None:
        """Reject anonymous plugins; the allowlist matches on name."""
        if not self.name.strip():
            msg = "plugin name must be non-empty"
            raise ValueError(msg)


@runtime_checkable
class Plugin(Protocol):
    """What every plugin implements.

    ``register`` receives a narrow, capability-scoped ``PluginContext`` —
    never the DI container or the settings object. That API shape is a
    deliberate day-one decision (Core Architecture §13): widening a narrow
    context later is backwards-compatible; narrowing a wide one breaks
    every plugin ever written against it.
    """

    @property
    def metadata(self) -> PluginMetadata:
        """The plugin's declared identity."""
        ...

    def register(self, context: PluginContext) -> None:
        """Bind the plugin's capabilities into the system at boot."""
        ...
