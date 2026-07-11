"""Trace persistence port and the in-memory V1 adapter.

The port lives with its consumer (orchestration) per the Dependency
Inversion detail in Core Architecture §3. The SQLite adapter arrives with
Phase 2B's CLI flow — the first moment anything outlives a process.
"""

from __future__ import annotations

from typing import Protocol

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.record import ReasoningTrace

__all__ = ["InMemoryReasoningTraceRepository", "ReasoningTraceRepositoryPort"]


class ReasoningTraceRepositoryPort(Protocol):
    """Append-only storage for completed reasoning traces.

    Deliberately no update or delete of individual traces: a trace is the
    audit record of what the system thought (EC §9, complete audit trail).
    Trader-controlled bulk export/delete arrives with the Memory Engine's
    data-stewardship surface, which owns personal-data lifecycles.
    """

    async def save(self, trace: ReasoningTrace) -> None:
        """Persist ``trace``.

        Raises:
            ValueError: If a trace with the same id is already stored —
                traces are immutable, never overwritten.
        """
        ...

    async def get(self, trace_id: EntityId) -> ReasoningTrace | None:
        """Return the trace with ``trace_id``, or ``None`` if unknown."""
        ...


class InMemoryReasoningTraceRepository:
    """Process-local trace store — the V1 default and the test double."""

    def __init__(self) -> None:
        """Create an empty repository."""
        self._traces: dict[EntityId, ReasoningTrace] = {}

    async def save(self, trace: ReasoningTrace) -> None:
        """Persist ``trace``, refusing overwrites."""
        if trace.trace_id in self._traces:
            msg = f"trace {trace.trace_id} already stored; traces are immutable"
            raise ValueError(msg)
        self._traces[trace.trace_id] = trace

    async def get(self, trace_id: EntityId) -> ReasoningTrace | None:
        """Return the trace with ``trace_id``, or ``None`` if unknown."""
        return self._traces.get(trace_id)
