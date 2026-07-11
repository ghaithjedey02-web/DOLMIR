from collections.abc import Callable

import pytest

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
from dolmir.orchestration.trace.synthesis import synthesize_confidence

OpinionFactory = Callable[..., AgentOpinion]


def _full_coverage(hypothesis_set: HypothesisSet) -> FalsificationReport:
    return FalsificationReport.for_hypotheses(hypothesis_set, ())


def test_unexplained_confidence_is_unconstructible(hypothesis_set: HypothesisSet) -> None:
    with pytest.raises(ValueError, match="basis"):
        ConfidenceAssessment(
            hypothesis_id=hypothesis_set.members[0].hypothesis_id,
            level=Confidence.HIGH,
            basis="  ",
        )


def test_synthesis_requires_full_falsification_coverage(
    hypothesis_set: HypothesisSet,
) -> None:
    partial = FalsificationReport(
        examined_hypothesis_ids=frozenset({hypothesis_set.members[0].hypothesis_id})
    )
    with pytest.raises(ValueError, match="does not cover"):
        synthesize_confidence(hypothesis_set, (), partial)


def test_unanimous_support_reaches_very_high(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    target = hypothesis_set.members[0]
    opinions = tuple(
        opinion_factory(role, hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.HIGH)})
        for role in ("analyst_a", "analyst_b")
    )
    report = synthesize_confidence(hypothesis_set, opinions, _full_coverage(hypothesis_set))

    assessment = report.for_hypothesis(target.hypothesis_id)
    assert assessment.level is Confidence.VERY_HIGH
    assert "weighted support" in assessment.basis


def test_no_expressed_stance_defaults_to_low_with_explanation(
    hypothesis_set: HypothesisSet,
) -> None:
    report = synthesize_confidence(hypothesis_set, (), _full_coverage(hypothesis_set))
    for member in hypothesis_set:
        assessment = report.for_hypothesis(member.hypothesis_id)
        assert assessment.level is Confidence.LOW
        assert "no agent expressed a stance" in assessment.basis


def test_opposition_drags_confidence_down(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    supporter = opinion_factory(
        "bull", hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.MODERATE)}
    )
    opposer = opinion_factory(
        "bear", hypothesis_set, {"the bearing": (Stance.OPPOSES, Confidence.VERY_HIGH)}
    )
    report = synthesize_confidence(
        hypothesis_set, (supporter, opposer), _full_coverage(hypothesis_set)
    )
    target = hypothesis_set.members[0]
    assert report.for_hypothesis(target.hypothesis_id).level is Confidence.LOW


def test_severe_challenge_caps_at_low_and_names_the_cap(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    target = hypothesis_set.members[0]
    opinions = tuple(
        opinion_factory(
            role, hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.VERY_HIGH)}
        )
        for role in ("a", "b", "c")
    )
    challenge = Challenge(
        hypothesis_id=target.hypothesis_id,
        objection="sensor was recently recalibrated; readings unreliable",
        severity=ChallengeSeverity.SEVERE,
    )
    report = synthesize_confidence(
        hypothesis_set,
        opinions,
        FalsificationReport.for_hypotheses(hypothesis_set, (challenge,)),
    )

    assessment = report.for_hypothesis(target.hypothesis_id)
    assert assessment.level is Confidence.LOW
    assert "capped at LOW" in assessment.basis
    assert "recalibrated" in assessment.basis


def test_material_challenge_caps_at_moderate(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    target = hypothesis_set.members[0]
    opinions = (
        opinion_factory(
            "a", hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.VERY_HIGH)}
        ),
    )
    challenge = Challenge(
        hypothesis_id=target.hypothesis_id,
        objection="only one sensor corroborates",
        severity=ChallengeSeverity.MATERIAL,
    )
    report = synthesize_confidence(
        hypothesis_set,
        opinions,
        FalsificationReport.for_hypotheses(hypothesis_set, (challenge,)),
    )
    assert report.for_hypothesis(target.hypothesis_id).level is Confidence.MODERATE


def test_abstentions_are_recorded_in_basis(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    abstainer = opinion_factory(
        "unsure", hypothesis_set, {"the bearing": (Stance.ABSTAINS, Confidence.LOW)}
    )
    report = synthesize_confidence(hypothesis_set, (abstainer,), _full_coverage(hypothesis_set))
    target = hypothesis_set.members[0]
    assert "abstention" in report.for_hypothesis(target.hypothesis_id).basis


def test_report_rejects_duplicates_and_unknown_lookup(hypothesis_set: HypothesisSet) -> None:
    target = hypothesis_set.members[0]
    assessment = ConfidenceAssessment(
        hypothesis_id=target.hypothesis_id, level=Confidence.LOW, basis="x"
    )
    with pytest.raises(ValueError, match="one assessment per hypothesis"):
        ConfidenceReport(assessments=(assessment, assessment))
    report = ConfidenceReport(assessments=(assessment,))
    with pytest.raises(KeyError):
        report.for_hypothesis(hypothesis_set.inaction.hypothesis_id)
