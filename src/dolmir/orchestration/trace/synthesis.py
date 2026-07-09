"""Deterministic confidence synthesis (Standing Rule 4).

Cognitive Architecture §3 stage 8: synthesis *aggregates* what the debate
and falsification stages accumulated — it is not a fresh judgment, and its
arithmetic is plain code, never delegated to an LLM.

Lives above ``confidence`` (the vocabulary) in the module layering because
it consumes opinions, and opinions themselves carry a ``Confidence``.
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.challenge import (
    Challenge,
    ChallengeSeverity,
    FalsificationReport,
)
from dolmir.orchestration.trace.confidence import (
    Confidence,
    ConfidenceAssessment,
    ConfidenceReport,
)
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, Stance

__all__ = ["synthesize_confidence"]

_SEVERITY_CAPS: dict[ChallengeSeverity, Confidence] = {
    ChallengeSeverity.SEVERE: Confidence.LOW,
    ChallengeSeverity.MATERIAL: Confidence.MODERATE,
}

_SUPPORT_THRESHOLDS: tuple[tuple[float, Confidence], ...] = (
    (0.8, Confidence.VERY_HIGH),
    (0.6, Confidence.HIGH),
    (0.4, Confidence.MODERATE),
)


def _aggregate_stances(
    hypothesis_id: EntityId, opinions: tuple[AgentOpinion, ...]
) -> tuple[Confidence, str]:
    """Weigh the debate's stances on one hypothesis into a level + basis."""
    supporting_weight = 0
    opposing_weight = 0
    abstentions = 0
    for opinion in opinions:
        assessment = opinion.assessment_for(hypothesis_id)
        if assessment is None:
            continue
        if assessment.stance is Stance.SUPPORTS:
            supporting_weight += int(assessment.confidence)
        elif assessment.stance is Stance.OPPOSES:
            opposing_weight += int(assessment.confidence)
        else:
            abstentions += 1

    expressed = supporting_weight + opposing_weight
    if expressed == 0:
        level = Confidence.LOW
        basis = "no agent expressed a stance; defaulting to LOW"
    else:
        ratio = supporting_weight / expressed
        level = Confidence.LOW
        for threshold, mapped in _SUPPORT_THRESHOLDS:
            if ratio >= threshold:
                level = mapped
                break
        basis = (
            f"weighted support {supporting_weight} vs opposition "
            f"{opposing_weight} (ratio {ratio:.2f})"
        )
    if abstentions:
        basis += f"; {abstentions} abstention(s)"
    return level, basis


def _apply_challenge_caps(
    level: Confidence, basis: str, challenges: tuple[Challenge, ...]
) -> tuple[Confidence, str]:
    """Cap a level by the standing challenges, naming every cap applied."""
    caps_applied: list[str] = []
    for challenge in challenges:
        cap = _SEVERITY_CAPS.get(challenge.severity)
        if cap is not None and cap < level:
            level = cap
            caps_applied.append(
                f"capped at {cap.name} by {challenge.severity.value} "
                f"challenge: {challenge.objection}"
            )
    if caps_applied:
        basis = basis + "; " + "; ".join(caps_applied)
    return level, basis


def synthesize_confidence(
    hypotheses: HypothesisSet,
    opinions: tuple[AgentOpinion, ...],
    falsification: FalsificationReport,
) -> ConfidenceReport:
    """Deterministically aggregate debate + falsification into confidence.

    The v1 heuristic, documented so it can be criticized and later replaced
    by calibration-derived weights (Phase 8/12 — the function signature is
    the stable part, the thresholds are not):

    1. For each hypothesis, weigh each opinion's stance by the opining
       agent's own stated confidence rank (1-4). Support ratio =
       supporting weight / (supporting + opposing weight). Abstentions
       count toward neither side but are recorded in the basis.
    2. Map ratio to a level: ≥0.8 VERY_HIGH, ≥0.6 HIGH, ≥0.4 MODERATE,
       else LOW. No expressed stances at all → LOW ("no support is not
       silent neutrality").
    3. Standing challenges cap the result (CC §9): any SEVERE challenge
       caps at LOW; any MATERIAL challenge caps at MODERATE. Caps are
       named in the basis.

    Raises:
        ValueError: If ``falsification`` does not attest coverage of every
            hypothesis in the set — synthesizing confidence from an
            incomplete falsification pass is exactly the shortcut CC §9
            forbids.
    """
    if not falsification.covers(hypotheses):
        msg = (
            "falsification report does not cover the full hypothesis set; "
            "confidence synthesis requires every hypothesis to have been "
            "examined (Cognitive Constitution §9)"
        )
        raise ValueError(msg)

    assessments: list[ConfidenceAssessment] = []
    for hypothesis in hypotheses:
        level, basis_core = _aggregate_stances(hypothesis.hypothesis_id, opinions)
        level, basis = _apply_challenge_caps(
            level,
            basis_core,
            falsification.challenges_against(hypothesis.hypothesis_id),
        )
        assessments.append(
            ConfidenceAssessment(hypothesis_id=hypothesis.hypothesis_id, level=level, basis=basis)
        )

    return ConfidenceReport(assessments=tuple(assessments))
