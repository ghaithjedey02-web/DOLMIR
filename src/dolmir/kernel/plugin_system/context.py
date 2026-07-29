"""The capability surface handed to plugins at registration."""

from __future__ import annotations

from dolmir.kernel.event_bus.integration_event import IntegrationEvent
from dolmir.kernel.event_bus.port import EventBusPort, EventHandler

__all__ = ["PluginContext"]


class PluginContext:
    """Narrow, explicit capabilities a plugin may use — nothing else.

    Grows one deliberate capability at a time as later phases add
    registrable surfaces (agents, adapters); it never becomes a passthrough
    to the container (Core Architecture §13). The sole Phase 1 capability
    is subscribing to integration events.
    """

    def __init__(self, event_bus: EventBusPort) -> None:
        """Wrap the capabilities granted for one registration pass."""
        self._event_bus = event_bus

    def subscribe[E: IntegrationEvent](self, event_type: type[E], handler: EventHandler[E]) -> None:
        """Subscribe the plugin to integration events of ``event_type``."""
        self._event_bus.subscribe(event_type, handler)
