"""Beliefs and the generic world model: durable, auditable understanding.

A ``Belief`` is a claim the system *holds over time*, with full provenance
(which traces/episodes produced it — EC §5: every remembered thing has a
reason for existing) and an explicit revision chain (belief updates are
never silent — EC §2). A ``WorldModel`` is the generic container of held
beliefs about one subject; the trading ``InstrumentWorldModel`` and the
``TraderProfile`` (CogA §8) are domain specializations of this same shape.

Only the shapes and their laws live here. Persistence belongs to Memory
Engine adapters (Phase 5+); consolidation — deriving beliefs from
accumulated episodes — belongs to Phase 12 (Docs/ROADMAP.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus

__all__ = ["Belief", "WorldModel"]


@dataclass(frozen=True, kw_only=True, slots=True)
class Belief:
    """One held claim, with provenance and a revision chain.

    Structural rules:

    - ``derived_from`` must be non-empty: a belief with no traceable origin
      is an unauditable prejudice (EC §5, CC §2).
    - The claim may not carry ``HYPOTHESIS`` status: hypotheses are
      per-run candidates under active debate, not held understanding. A
      hypothesis that keeps surviving becomes a belief by being *derived*
      (with provenance) — never by silent promotion.
    - Revision is append-only: a changed mind is a new ``Belief`` whose
      ``supersedes`` names the old one. History is never rewritten.
    """

    schema_version: ClassVar[int] = 1

    belief_id: EntityId
    claim: Claim
    formed_at: datetime
    derived_from: tuple[EntityId, ...]
    supersedes: EntityId | None = None

    def __post_init__(self) -> None:
        """Enforce provenance, status, and timestamp rules."""
        if not self.derived_from:
            msg = (
                "Belief.derived_from must reference at least one source "
                "trace/episode — beliefs without provenance are not "
                "auditable (Engineering Constitution §5)"
            )
            raise ValueError(msg)
        if self.claim.status is EpistemicStatus.HYPOTHESIS:
            msg = (
                "a Belief cannot hold a HYPOTHESIS-status claim: hypotheses "
                "are per-run candidates, not held understanding — derive an "
                "ASSUMPTION or FACT claim instead"
            )
            raise ValueError(msg)
        if self.formed_at.tzinfo is None:
            msg = "Belief.formed_at must be timezone-aware"
            raise ValueError(msg)
        if self.supersedes == self.belief_id:
            msg = "a Belief cannot supersede itself"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class WorldModel:
    """The held beliefs about one subject, as of a moment.

    Immutable: revision produces a new ``WorldModel`` via
    :meth:`revised`, so every historical state of understanding remains
    reconstructable (EC §9, audit trail). ``subject`` names what is being
    modeled — an instrument, a trader, a patient, a machine — the kernel
    does not care which.
    """

    schema_version: ClassVar[int] = 1

    model_id: EntityId
    subject: str
    as_of: datetime
    beliefs: tuple[Belief, ...] = ()

    def __post_init__(self) -> None:
        """Enforce identity, timestamp, and uniqueness rules."""
        if not self.subject.strip():
            msg = "WorldModel.subject must be non-empty"
            raise ValueError(msg)
        if self.as_of.tzinfo is None:
            msg = "WorldModel.as_of must be timezone-aware"
            raise ValueError(msg)
        ids = [belief.belief_id for belief in self.beliefs]
        if len(set(ids)) != len(ids):
            msg = "WorldModel beliefs must have unique ids"
            raise ValueError(msg)

    def belief(self, belief_id: EntityId) -> Belief:
        """The held belief with ``belief_id``.

        Raises:
            KeyError: If no such belief is held.
        """
        for held in self.beliefs:
            if held.belief_id == belief_id:
                return held
        msg = f"no belief with id {belief_id}"
        raise KeyError(msg)

    def revised(self, new_belief: Belief, *, as_of: datetime) -> WorldModel:
        """A new model holding ``new_belief``, retiring what it supersedes.

        If ``new_belief.supersedes`` names a held belief, that belief is
        removed from the active set (its history lives on in the superseded
        object and, later, in Memory Engine's stores).

        Raises:
            ValueError: If ``new_belief.supersedes`` names a belief this
                model does not hold — a revision of nothing is a wiring bug,
                not a quiet no-op.
        """
        remaining = self.beliefs
        if new_belief.supersedes is not None:
            held_ids = {held.belief_id for held in self.beliefs}
            if new_belief.supersedes not in held_ids:
                msg = (
                    f"new belief supersedes {new_belief.supersedes}, which "
                    "this world model does not hold"
                )
                raise ValueError(msg)
            remaining = tuple(
                held for held in self.beliefs if held.belief_id != new_belief.supersedes
            )
        return WorldModel(
            model_id=self.model_id,
            subject=self.subject,
            as_of=as_of,
            beliefs=(*remaining, new_belief),
        )
