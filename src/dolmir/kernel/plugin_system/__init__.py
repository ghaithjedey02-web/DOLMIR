"""Plugin system: contract, capability context, allowlisted registry (CA §13)."""

from dolmir.kernel.plugin_system.context import PluginContext
from dolmir.kernel.plugin_system.plugin import Plugin, PluginMetadata
from dolmir.kernel.plugin_system.registry import (
    PluginRegistrationError,
    PluginRegistry,
    RegistrationReport,
)

__all__ = [
    "Plugin",
    "PluginContext",
    "PluginMetadata",
    "PluginRegistrationError",
    "PluginRegistry",
    "RegistrationReport",
]
