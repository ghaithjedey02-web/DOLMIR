"""Assembled context: the Context Building stage's typed output.

Cognitive Architecture §3 stage 3 / Core Architecture §11: context building
pulls in the prior knowledge relevant to a run. The generic kernel form is
a bundle of epistemically-tagged claims; the concrete ``ContextAssembler``
(Phase 5) will populate it by fanning out to the Knowledge and Memory
engines. The kernel does not know where the claims came from — only that
each carries its epistemic status (CC §8), so downstream stages never
mistake retrieved doctrine for a fresh observation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from dolmir.orchestration.trace.epistemic import Claim

__all__ = ["AssembledContext"]


@dataclass(frozen=True, slots=True)
class AssembledContext:
    """Prior knowledge assembled for a reasoning run.

    Deliberately minimal: a run with no retrievable prior context is valid
    (an empty bundle), so there is no non-empty rule here. Every item keeps
    its epistemic status, which is the whole point — context enriches
    reasoning without being promoted to observation or fact.
    """

    schema_version: ClassVar[int] = 1

    items: tuple[Claim, ...] = ()
