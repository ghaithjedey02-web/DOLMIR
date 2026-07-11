"""The Event Bus port — cross-engine, decoupled facts."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from dolmir.kernel.event_bus.integration_event import IntegrationEvent

__all__ = ["EventBusPort", "EventHandler"]

type EventHandler[E: IntegrationEvent] = Callable[[E], Awaitable[None]]


class EventBusPort(Protocol):
    """Publish/subscribe for integration events.

    Delivery contract:

    - A handler receives every published event that is an instance of the
      type it subscribed to (subclasses included).
    - Handler failures are isolated: one failing subscriber never prevents
      delivery to the others, and never propagates to the publisher. The
      failure is loudly logged — a decoupled fact's publisher cannot
      meaningfully handle a stranger's exception (Core Architecture §9/§16).
    - Ordering across different subscribers is unspecified; adapters may
      deliver sequentially or concurrently.
    """

    async def publish(self, event: IntegrationEvent) -> None:
        """Deliver ``event`` to all matching subscribers."""
        ...

    def subscribe[E: IntegrationEvent](self, event_type: type[E], handler: EventHandler[E]) -> None:
        """Register ``handler`` for events of ``event_type`` (and subclasses)."""
        ...
