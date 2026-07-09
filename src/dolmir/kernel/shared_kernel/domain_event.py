"""Base type for domain events raised inside a single engine.

Domain Events are in-process facts within one bounded context
(``MarketStructureShiftDetected``); Integration Events — a separate type in
``dolmir.kernel.event_bus`` — are the coarser, cross-engine facts. The two
are deliberately distinct classes (Core Architecture §9).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar

from dolmir.kernel.shared_kernel.entity_id import EntityId

__all__ = ["DomainEvent"]


@dataclass(frozen=True, kw_only=True, slots=True)
class DomainEvent:
    """Immutable base for all domain events.

    Subclasses add their payload fields and are named in the past tense
    (``DecisionFinalized``, never ``FinalizeDecision``) — Core
    Architecture §15.

    ``occurred_at`` is always injected by the caller from a ``ClockPort``
    (Standing Rule 7): event types never read the system clock themselves,
    which is what keeps them usable verbatim in backtests and replays.

    ``schema_version`` (Standing Rule 6) is a per-class constant that
    subclasses MUST bump on any breaking change to their field shape.
    Persistence adapters store ``type(event).schema_version`` alongside the
    payload so future upcasters can migrate old records; the upcaster
    registry itself arrives with the first persistence adapter (Phase 2).
    """

    schema_version: ClassVar[int] = 1

    event_id: EntityId
    occurred_at: datetime

    def __post_init__(self) -> None:
        """Reject naive timestamps; event times are always timezone-aware."""
        if self.occurred_at.tzinfo is None:
            msg = f"{type(self).__name__}.occurred_at must be timezone-aware"
            raise ValueError(msg)
