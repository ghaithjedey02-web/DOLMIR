import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.challenge import (
    Challenge,
    ChallengeSeverity,
    FalsificationReport,
)
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance


def _assessment(hypothesis_id: EntityId, stance: Stance = Stance.SUPPORTS) -> HypothesisAssessment:
    return HypothesisAssessment(
        hypothesis_id=hypothesis_id,
        stance=stance,
        confidence=Confidence.MODERATE,
        reasoning="because the spectrum matches",
    )


def test_unreasoned_assessment_rejected() -> None:
    with pytest.raises(ValueError, match="reasoning"):
        HypothesisAssessment(
            hypothesis_id=EntityId.generate(),
            stance=Stance.SUPPORTS,
            confidence=Confidence.HIGH,
            reasoning="  ",
        )


def test_opinion_requires_identity_and_assessments() -> None:
    with pytest.raises(ValueError, match="role"):
        AgentOpinion(
            role=" ", strategy_version="v1", assessments=(_assessment(EntityId.generate()),)
        )
    with pytest.raises(ValueError, match="strategy_version"):
        AgentOpinion(
            role="analyst", strategy_version=" ", assessments=(_assessment(EntityId.generate()),)
        )
    with pytest.raises(ValueError, match="at least one"):
        AgentOpinion(role="analyst", strategy_version="v1", assessments=())


def test_opinion_rejects_duplicate_hypothesis_assessments() -> None:
    hypothesis_id = EntityId.generate()
    with pytest.raises(ValueError, match="at most once"):
        AgentOpinion(
            role="analyst",
            strategy_version="v1",
            assessments=(_assessment(hypothesis_id), _assessment(hypothesis_id, Stance.OPPOSES)),
        )


def test_opinion_lookup_returns_none_for_unassessed() -> None:
    opinion = AgentOpinion(
        role="analyst", strategy_version="v1", assessments=(_assessment(EntityId.generate()),)
    )
    assert opinion.assessment_for(EntityId.generate()) is None


def test_challenge_requires_objection() -> None:
    with pytest.raises(ValueError, match="objection"):
        Challenge(
            hypothesis_id=EntityId.generate(),
            objection=" ",
            severity=ChallengeSeverity.MINOR,
        )


def test_report_rejects_challenge_outside_examined_set() -> None:
    with pytest.raises(ValueError, match="does not attest examining"):
        FalsificationReport(
            examined_hypothesis_ids=frozenset({EntityId.generate()}),
            challenges=(
                Challenge(
                    hypothesis_id=EntityId.generate(),
                    objection="unexamined target",
                    severity=ChallengeSeverity.SEVERE,
                ),
            ),
        )


def test_report_coverage_and_per_hypothesis_lookup(hypothesis_set: HypothesisSet) -> None:
    target = hypothesis_set.members[0]
    challenge = Challenge(
        hypothesis_id=target.hypothesis_id,
        objection="the 2x peak could be electrical noise",
        severity=ChallengeSeverity.MATERIAL,
    )
    report = FalsificationReport.for_hypotheses(hypothesis_set, (challenge,))

    assert report.covers(hypothesis_set)
    assert report.challenges_against(target.hypothesis_id) == (challenge,)
    assert report.challenges_against(hypothesis_set.inaction.hypothesis_id) == ()


def test_partial_report_does_not_cover_the_set(hypothesis_set: HypothesisSet) -> None:
    partial = FalsificationReport(
        examined_hypothesis_ids=frozenset({hypothesis_set.members[0].hypothesis_id})
    )
    assert not partial.covers(hypothesis_set)
