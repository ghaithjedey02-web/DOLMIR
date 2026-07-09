"""Structured reasoning objects and the persisted ReasoningTrace.

Every object here is typed and validated at construction — free-form text
exists only as *content inside* structured fields, never as the structure
itself. The Cognitive Constitution's rules are constructor rules: an
ungrounded FACT, an unfalsifiable Hypothesis, a hypothesis set without an
inaction option, and an unexplained Confidence are all unconstructible.
"""

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
from dolmir.orchestration.trace.epistemic import (
    Claim,
    EpistemicStatus,
    Evidence,
    EvidenceKind,
)
from dolmir.orchestration.trace.explanation import Explanation, build_explanation
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance
from dolmir.orchestration.trace.record import (
    ReasoningTrace,
    RunStatus,
    StepStatus,
    TraceStep,
)
from dolmir.orchestration.trace.repository import (
    InMemoryReasoningTraceRepository,
    ReasoningTraceRepositoryPort,
)
from dolmir.orchestration.trace.synthesis import synthesize_confidence

__all__ = [
    "AgentOpinion",
    "Challenge",
    "ChallengeSeverity",
    "Claim",
    "Conclusion",
    "Confidence",
    "ConfidenceAssessment",
    "ConfidenceReport",
    "EpistemicStatus",
    "Evidence",
    "EvidenceKind",
    "Explanation",
    "FalsificationReport",
    "Hypothesis",
    "HypothesisAssessment",
    "HypothesisSet",
    "InMemoryReasoningTraceRepository",
    "ReasoningTrace",
    "ReasoningTraceRepositoryPort",
    "RunStatus",
    "Stance",
    "StepStatus",
    "TraceStep",
    "build_explanation",
    "synthesize_confidence",
]
