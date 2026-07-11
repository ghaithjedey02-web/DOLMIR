"""Event Bus: port, base event type, and the in-memory V1 adapter.

Scope rule (Standing Rule 3): the bus carries decoupled, cross-engine facts
between requests — never node-to-node handoff inside one Reasoning Graph
run. That confusion is called out as an anti-pattern in Core Architecture
§8 precisely because it becomes tempting the moment both mechanisms exist.
"""

from dolmir.kernel.event_bus.in_memory_event_bus import InMemoryEventBus
from dolmir.kernel.event_bus.integration_event import IntegrationEvent
from dolmir.kernel.event_bus.port import EventBusPort, EventHandler

__all__ = ["EventBusPort", "EventHandler", "InMemoryEventBus", "IntegrationEvent"]
