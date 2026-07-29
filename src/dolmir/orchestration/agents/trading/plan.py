"""ProposedTrades: the artifact linking actionable hypotheses to concrete trades.

Cognitive Architecture §3 stage 9 turns a chosen hypothesis into a concrete
proposal (direction, entry, invalidation, objective, size). Those proposals
are formed at hypothesis time by the (LLM) generator — which alone knows the
levels a scenario implies — and carried through the graph as this typed
artifact, so the *deterministic* Risk Gate downstream judges numbers it did
not invent (Standing Rule 4: the model proposes, plain code decides). The
inaction hypothesis has no proposal, by definition.

``ProposedTrades`` lives in orchestration (it flows through the graph and
references the trace's ``EntityId``s); it imports the Risk Engine's
``TradeProposal`` — orchestration may depend on engines (Core Architecture
§4), never the reverse.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from dolmir.engines.risk_engine.domain import TradeProposal
from dolmir.kernel.shared_kernel import EntityId

__all__ = ["ProposedTrades"]


@dataclass(frozen=True, slots=True)
class ProposedTrades:
    """Concrete trade proposals keyed by the hypothesis each expresses.

    Stored as an ordered tuple of ``(hypothesis_id, proposal)`` pairs rather
    than a dict so the artifact serializes deterministically through
    ``to_document`` (Standing Rule 6) — a dict keyed by ``EntityId`` would
    not.
    """

    schema_version: ClassVar[int] = 1

    proposals: tuple[tuple[EntityId, TradeProposal], ...] = ()

    def __post_init__(self) -> None:
        """Reject duplicate hypothesis keys."""
        ids = [hypothesis_id for hypothesis_id, _ in self.proposals]
        if len(set(ids)) != len(ids):
            msg = "ProposedTrades may hold at most one proposal per hypothesis"
            raise ValueError(msg)

    def for_hypothesis(self, hypothesis_id: EntityId) -> TradeProposal | None:
        """The proposal expressing ``hypothesis_id``, or ``None`` if none."""
        for candidate_id, proposal in self.proposals:
            if candidate_id == hypothesis_id:
                return proposal
        return None
