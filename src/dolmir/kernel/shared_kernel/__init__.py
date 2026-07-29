"""Shared value objects and primitives used across all engines.

Change control (Core Architecture §5): this is the riskiest package to
modify in the entire codebase — every engine imports it. Anything
engine-specific belongs in that engine with an anti-corruption mapper at
its boundary, never as a new field on a shared type.

``Money`` is deliberately absent: its precision/rounding/currency semantics
will be dictated by its first real consumer (Risk/Journal engine work) —
see the approved Phase 1 plan.
"""

from dolmir.kernel.shared_kernel.domain_event import DomainEvent
from dolmir.kernel.shared_kernel.entity_id import EntityId
from dolmir.kernel.shared_kernel.result import Err, Ok, Result
from dolmir.kernel.shared_kernel.symbol import Symbol
from dolmir.kernel.shared_kernel.time_range import TimeRange

__all__ = [
    "DomainEvent",
    "EntityId",
    "Err",
    "Ok",
    "Result",
    "Symbol",
    "TimeRange",
]
