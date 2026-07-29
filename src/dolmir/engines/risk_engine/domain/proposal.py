"""The trade proposal: a concrete, gate-checkable expression of a hypothesis.

Cognitive Architecture §3 stage 9 turns a chosen hypothesis plus its
confidence into a concrete proposal — a direction, an entry, an invalidation
(stop), an objective (target), and the fraction of equity risked. Direction
coherence is a construction invariant: a "long" whose stop sits above entry
is not a risky trade, it is a nonsensical one, so it cannot be built.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import ClassVar

__all__ = ["TradeDirection", "TradeProposal"]


class TradeDirection(enum.Enum):
    """Which way a proposed trade faces."""

    LONG = "long"
    SHORT = "short"


@dataclass(frozen=True, kw_only=True, slots=True)
class TradeProposal:
    """A concrete trade the Risk Gate can evaluate deterministically.

    Prices are plain positive floats (no ``Money`` yet — deferred). The
    invariants below make an incoherent proposal unrepresentable, so the
    gate only ever reasons about well-formed trades:

    - all prices positive;
    - LONG: ``stop < entry < target`` (stop below, objective above);
    - SHORT: ``target < entry < stop`` (objective below, stop above);
    - ``risk_fraction_of_equity`` positive.
    """

    schema_version: ClassVar[int] = 1

    symbol: str
    direction: TradeDirection
    entry: float
    stop: float
    target: float
    risk_fraction_of_equity: float

    def __post_init__(self) -> None:
        """Enforce price positivity and direction coherence."""
        if not self.symbol.strip():
            msg = "TradeProposal.symbol must be non-empty"
            raise ValueError(msg)
        if min(self.entry, self.stop, self.target) <= 0.0:
            msg = "TradeProposal prices (entry, stop, target) must be positive"
            raise ValueError(msg)
        if self.risk_fraction_of_equity <= 0.0:
            msg = "TradeProposal.risk_fraction_of_equity must be positive"
            raise ValueError(msg)
        self._check_direction_coherence()

    def _check_direction_coherence(self) -> None:
        """Reject stops/targets on the wrong side of entry for the direction."""
        if self.direction is TradeDirection.LONG and not self.stop < self.entry < self.target:
            msg = (
                "a LONG TradeProposal requires stop < entry < target "
                f"(got stop={self.stop}, entry={self.entry}, target={self.target})"
            )
            raise ValueError(msg)
        if self.direction is TradeDirection.SHORT and not self.target < self.entry < self.stop:
            msg = (
                "a SHORT TradeProposal requires target < entry < stop "
                f"(got target={self.target}, entry={self.entry}, stop={self.stop})"
            )
            raise ValueError(msg)

    @property
    def risk_distance(self) -> float:
        """Absolute price distance from entry to the invalidation stop."""
        return abs(self.entry - self.stop)

    @property
    def reward_distance(self) -> float:
        """Absolute price distance from entry to the objective target."""
        return abs(self.target - self.entry)

    @property
    def reward_to_risk(self) -> float:
        """The proposal's reward-to-risk ratio."""
        return self.reward_distance / self.risk_distance
