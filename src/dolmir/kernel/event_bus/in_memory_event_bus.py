"""In-process Event Bus adapter — the V1 default.

A single-process modular monolith needs nothing more (Core Architecture
§9); the documented upgrade path to Redis Streams/NATS is a new adapter
behind the same port, not a redesign.
"""

from __future__ import annotations

import structlog

from dolmir.kernel.event_bus.integration_event import IntegrationEvent
from dolmir.kernel.event_bus.port import EventHandler

__all__ = ["InMemoryEventBus"]

_logger = structlog.get_logger(__name__)


class InMemoryEventBus:
    """Sequential, in-process pub/sub implementing ``EventBusPort``.

    Handlers run one at a time in subscription order. A raising handler is
    logged at error level with full context and delivery continues — per
    the port's failure-isolation contract. Nothing is ever swallowed
    silently: the log line carries the event type, handler name, and the
    exception.
    """

    def __init__(self) -> None:
        """Create an empty bus with no subscriptions."""
        self._handlers: list[tuple[type[IntegrationEvent], EventHandler[IntegrationEvent]]] = []

    def subscribe[E: IntegrationEvent](self, event_type: type[E], handler: EventHandler[E]) -> None:
        """Register ``handler`` for ``event_type`` and its subclasses."""
        # The cast is safe: dispatch only ever invokes the handler with
        # instances of the exact type it was registered against.
        self._handlers.append(
            (event_type, handler)  # type: ignore[arg-type]
        )

    async def publish(self, event: IntegrationEvent) -> None:
        """Deliver ``event`` sequentially to every matching handler."""
        for registered_type, handler in self._handlers:
            if not isinstance(event, registered_type):
                continue
            try:
                await handler(event)
            except Exception:
                _logger.exception(
                    "event handler failed; continuing delivery to remaining handlers",
                    event_type=type(event).__name__,
                    event_id=str(event.event_id),
                    handler=getattr(handler, "__qualname__", repr(handler)),
                )
