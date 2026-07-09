"""Configuration system: schema, loader, and boundary errors (CA §10)."""

from dolmir.kernel.config.loader import InvalidConfigurationError, load_settings
from dolmir.kernel.config.settings import DolmirSettings, PluginSettings

__all__ = [
    "DolmirSettings",
    "InvalidConfigurationError",
    "PluginSettings",
    "load_settings",
]
