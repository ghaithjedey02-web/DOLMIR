"""Structured reasoning objects and the persisted ReasoningTrace.

Every object here is typed and validated at construction — free-form text
exists only as *content inside* structured fields, never as the structure
itself. The Cognitive Constitution's rules are constructor rules: an
ungrounded FACT, an unfalsifiable Hypothesis, a hypothesis set without an
inaction option, an unexplained Confidence, an inaction-less decision over
unacceptable risk, and a provenance-free Belief are all unconstructible.

See ``dolmir/orchestration/README.md`` for the complete concept-to-code
map of the cognitive kernel.
"""

from dolmir.orchestration.trace.belief import Belief, WorldModel
from dolmir.orchestration.trace.challenge import (
    Challenge,
    ChallengeSeverity,
    FalsificationReport,
)
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import (
    Confidence,
    ConfidenceAssessment,
    ConfidenceReport,
)
from dolmir.orchestration.trace.decision import (
    Decision,
    IdentifiedRisk,
    RiskAssessment,
    RiskMagnitude,
)
from dolmir.orchestration.trace.epistemic import (
    Claim,
    EpistemicStatus,
    Evidence,
    EvidenceKind,
)
from dolmir.orchestration.trace.explanation import Explanation, build_explanation
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.observation import (
    Interpretation,
    Observation,
    ObservationSet,
)
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance
from dolmir.orchestration.trace.record import (
    ReasoningTrace,
    RunStatus,
    StepStatus,
    TraceStep,
)
from dolmir.orchestration.trace.reflection import (
    LearningSignal,
    LearningSignalKind,
    Reflection,
)
from dolmir.orchestration.trace.repository import (
    InMemoryReasoningTraceRepository,
    ReasoningTraceRepositoryPort,
)
from dolmir.orchestration.trace.serialization import JsonValue, to_document
from dolmir.orchestration.trace.synthesis import synthesize_confidence
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind

__all__ = [
    "AgentOpinion",
    "Belief",
    "Challenge",
    "ChallengeSeverity",
    "Claim",
    "Conclusion",
    "Confidence",
    "ConfidenceAssessment",
    "ConfidenceReport",
    "Decision",
    "EpistemicStatus",
    "Evidence",
    "EvidenceKind",
    "Explanation",
    "FalsificationReport",
    "Hypothesis",
    "HypothesisAssessment",
    "HypothesisSet",
    "IdentifiedRisk",
    "InMemoryReasoningTraceRepository",
    "Interpretation",
    "JsonValue",
    "LearningSignal",
    "LearningSignalKind",
    "Observation",
    "ObservationSet",
    "ReasoningTrace",
    "ReasoningTraceRepositoryPort",
    "Reflection",
    "RiskAssessment",
    "RiskMagnitude",
    "RunStatus",
    "Stance",
    "StepStatus",
    "TraceStep",
    "Uncertainty",
    "UncertaintyKind",
    "WorldModel",
    "build_explanation",
    "synthesize_confidence",
    "to_document",
]
