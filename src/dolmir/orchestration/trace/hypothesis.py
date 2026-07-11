"""Hypotheses: falsifiable forward-looking scenarios, including inaction.

Cognitive Constitution §4: a hypothesis with no stated falsification
condition is an opinion, not a hypothesis, and may not drive a decision —
so the falsification condition is a required constructor argument, locked
in at creation time, before any outcome exists.

Cognitive Constitution §6: "no clear edge — do nothing" must always be a
reachable, legitimate conclusion — so a ``HypothesisSet`` structurally
requires exactly one inaction hypothesis among its members.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from dolmir.kernel.shared_kernel import EntityId

__all__ = ["Hypothesis", "HypothesisSet"]

_MINIMUM_MEMBERS = 2


@dataclass(frozen=True, kw_only=True, slots=True)
class Hypothesis:
    """One mutually-exclusive candidate scenario under consideration.

    ``falsification_condition`` is pre-registered (CC §4): it states, at
    formation time, what evidence would prove this hypothesis wrong. The
    slow loop later grades outcomes against this locked-in condition, never
    against a reconstructed-after-the-fact expectation.

    ``represents_inaction`` marks the generic null option — "conclude
    nothing / act on nothing" (CC §6). Domain layers give it domain meaning
    ("no trade", "no diagnosis yet"); the engine only guarantees it exists
    and is choosable.
    """

    hypothesis_id: EntityId
    statement: str
    falsification_condition: str
    represents_inaction: bool = False

    def __post_init__(self) -> None:
        """Reject unfalsifiable or empty hypotheses."""
        if not self.statement.strip():
            msg = "Hypothesis.statement must be non-empty"
            raise ValueError(msg)
        if not self.falsification_condition.strip():
            msg = (
                "Hypothesis.falsification_condition must be non-empty: a "
                "hypothesis that nothing could prove wrong is an opinion, "
                "not a hypothesis (Cognitive Constitution §4)"
            )
            raise ValueError(msg)


@dataclass(frozen=True, slots=True)
class HypothesisSet:
    """The candidate scenarios one reasoning run debates.

    Structural rules:

    - at least two members (a "set" of one is a foregone conclusion);
    - exactly one member represents inaction (CC §6) — always present,
      never a fallback bolted on when nothing else fits;
    - no duplicate hypothesis ids.
    """

    members: tuple[Hypothesis, ...]

    def __post_init__(self) -> None:
        """Enforce set composition rules."""
        if len(self.members) < _MINIMUM_MEMBERS:
            msg = (
                "HypothesisSet requires at least two hypotheses — a single "
                "candidate is a foregone conclusion, not a deliberation"
            )
            raise ValueError(msg)
        inaction_count = sum(1 for member in self.members if member.represents_inaction)
        if inaction_count != 1:
            msg = (
                f"HypothesisSet requires exactly one inaction hypothesis, found "
                f"{inaction_count} (Cognitive Constitution §6: doing nothing must "
                "always be a reachable, legitimate conclusion)"
            )
            raise ValueError(msg)
        ids = [member.hypothesis_id for member in self.members]
        if len(set(ids)) != len(ids):
            msg = "HypothesisSet members must have unique hypothesis ids"
            raise ValueError(msg)

    @property
    def inaction(self) -> Hypothesis:
        """The set's single inaction member."""
        return next(member for member in self.members if member.represents_inaction)

    def get(self, hypothesis_id: EntityId) -> Hypothesis:
        """Return the member with ``hypothesis_id``.

        Raises:
            KeyError: If no member has that id.
        """
        for member in self.members:
            if member.hypothesis_id == hypothesis_id:
                return member
        msg = f"no hypothesis with id {hypothesis_id}"
        raise KeyError(msg)

    def ids(self) -> frozenset[EntityId]:
        """All member ids."""
        return frozenset(member.hypothesis_id for member in self.members)

    def __iter__(self) -> Iterator[Hypothesis]:
        """Iterate over members in declaration order."""
        return iter(self.members)
