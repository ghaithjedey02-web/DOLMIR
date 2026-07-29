"""Structured-logging bootstrap (CA §17). Emit via ``structlog.get_logger``."""

from dolmir.kernel.logging.setup import configure_logging

__all__ = ["configure_logging"]
