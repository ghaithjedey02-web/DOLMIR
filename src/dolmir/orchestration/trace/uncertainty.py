"""Uncertainty as a typed, two-kind concept — never blended into one number.

Cognitive Architecture §5: *aleatory* uncertainty is irreducible (the world
is genuinely stochastic here; more analysis will never resolve it), while
*epistemic* uncertainty is reducible (something specific will resolve it,
e.g. a pending measurement). Confidence reflects the former; a flagged
"pending resolution" reflects the latter — and the type system keeps them
apart: an aleatory uncertainty cannot carry a resolution, an epistemic one
must.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

__all__ = ["Uncertainty", "UncertaintyKind"]


class UncertaintyKind(enum.Enum):
    """Whether more information could resolve this uncertainty."""

    ALEATORY = "aleatory"
    """Irreducible randomness — no amount of further analysis resolves it."""

    EPISTEMIC = "epistemic"
    """Reducible — a specific, nameable thing will resolve it."""


@dataclass(frozen=True, kw_only=True, slots=True)
class Uncertainty:
    """One explicitly acknowledged unknown.

    Structural rules (CogA §5, made unconstructible-if-violated):

    - ``EPISTEMIC`` requires ``resolution`` — if you claim it is reducible,
      you must say what would reduce it.
    - ``ALEATORY`` forbids ``resolution`` — claiming a resolution for
      irreducible randomness is exactly the confusion the two kinds exist
      to prevent.
    """

    kind: UncertaintyKind
    description: str
    resolution: str | None = None

    def __post_init__(self) -> None:
        """Enforce the kind/resolution coherence rules."""
        if not self.description.strip():
            msg = "Uncertainty.description must be non-empty"
            raise ValueError(msg)
        if self.kind is UncertaintyKind.EPISTEMIC and not (self.resolution or "").strip():
            msg = (
                "an EPISTEMIC uncertainty must name what will resolve it "
                "(Cognitive Architecture §5)"
            )
            raise ValueError(msg)
        if self.kind is UncertaintyKind.ALEATORY and self.resolution is not None:
            msg = (
                "an ALEATORY uncertainty is irreducible and cannot carry a "
                "resolution (Cognitive Architecture §5)"
            )
            raise ValueError(msg)
