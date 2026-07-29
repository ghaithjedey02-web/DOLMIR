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
    ContextBuildingNode,
    DecisionNode,
    DeliberationNode,
    FalsificationNode,
    HypothesisGenerationNode,
    InterpretationNode,
    PerceptionNode,
    ReflectionNode,
    RiskEvaluationNode,
    WorldModelUpdateNode,
)

__all__ = [
    "ChiefDecisionNode",
    "ChiefDecisionPort",
    "ConfidenceSynthesisNode",
    "ContextBuildingNode",
    "DecisionNode",
    "DeliberationNode",
    "DeterministicChiefDecision",
    "FalsificationNode",
    "HypothesisGenerationNode",
    "InterpretationNode",
    "PerceptionNode",
    "ReflectionNode",
    "RiskEvaluationNode",
    "WorldModelUpdateNode",
]
