"""Structured logging configuration (Core Architecture §17).

Structured logs only: JSON in production, pretty console rendering in
dev/test. Called once by each composition root at boot — library code never
configures logging, it only emits through ``structlog.get_logger``.

Operational logs are deliberately separate from the ``ReasoningTrace``
domain artifact: one answers "was the system healthy", the other "what did
the system think" (CA §17). Nothing here persists domain data.
"""

from __future__ import annotations

import logging

import structlog

from dolmir.kernel.config.settings import DolmirSettings

__all__ = ["configure_logging"]


def configure_logging(settings: DolmirSettings) -> None:
    """Configure structlog process-wide from validated settings.

    Idempotent: safe to call once per process from any composition root.
    """
    renderer: structlog.typing.Processor
    if settings.environment == "prod":
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, settings.log_level)),
        cache_logger_on_first_use=True,
    )
