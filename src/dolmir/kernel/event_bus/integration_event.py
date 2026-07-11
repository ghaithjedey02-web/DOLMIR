"""Base type for integration events — facts that cross engine boundaries."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar

from dolmir.kernel.shared_kernel.entity_id import EntityId

__all__ = ["IntegrationEvent"]


@dataclass(frozen=True, kw_only=True, slots=True)
class IntegrationEvent:
    """Immutable base for events published on the Event Bus.

    Integration events are coarse-grained, past-tense facts other engines
    may care about (``AnalysisCompleted``, ``TradeOutcomeRecorded``) — Core
    Architecture §9. They are deliberately a separate type from
    ``DomainEvent``: domain events are intra-engine detail; integration
    events are the published, cross-context vocabulary, and the two evolve
    under different compatibility pressures.

    The Event Bus is never used for node-to-node handoff inside a Reasoning
    Graph run (Standing Rule 3) — that is the graph executor's job.

    ``schema_version`` follows Standing Rule 6, exactly as on
    ``DomainEvent``.
    """

    schema_version: ClassVar[int] = 1

    event_id: EntityId
    occurred_at: datetime

    def __post_init__(self) -> None:
        """Reject naive timestamps; event times are always timezone-aware."""
        if self.occurred_at.tzinfo is None:
            msg = f"{type(self).__name__}.occurred_at must be timezone-aware"
            raise ValueError(msg)
