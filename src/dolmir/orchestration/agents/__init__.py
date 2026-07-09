"""Agent-facing stage toolkit: deliberation, falsification, synthesis, decision.

Subclasses supply judgment (LLM-backed from Phase 2B); these bases supply
the contracts that make the Cognitive Constitution structurally
enforceable. Debate is not a mechanism — it is several DeliberationNodes
in the same wave, accumulating opinions.
"""

from dolmir.orchestration.agents.chief_decision import (
    ChiefDecisionPort,
    DeterministicChiefDecision,
)
from dolmir.orchestration.agents.stages import (
    ChiefDecisionNode,
    ConfidenceSynthesisNode,
    DeliberationNode,
    FalsificationNode,
)

__all__ = [
    "ChiefDecisionNode",
    "ChiefDecisionPort",
    "ConfidenceSynthesisNode",
    "DeliberationNode",
    "DeterministicChiefDecision",
    "FalsificationNode",
]
