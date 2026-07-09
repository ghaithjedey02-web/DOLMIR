from collections.abc import Callable

from dolmir.orchestration.agents.chief_decision import DeterministicChiefDecision
from dolmir.orchestration.trace.challenge import (
    Challenge,
    ChallengeSeverity,
    FalsificationReport,
)
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, Stance
from dolmir.orchestration.trace.synthesis import synthesize_confidence

OpinionFactory = Callable[..., AgentOpinion]


def _decide(
    hypothesis_set: HypothesisSet,
    opinions: tuple[AgentOpinion, ...],
    challenges: tuple[Challenge, ...] = (),
) -> Conclusion:
    falsification = FalsificationReport.for_hypotheses(hypothesis_set, challenges)
    confidence = synthesize_confidence(hypothesis_set, opinions, falsification)
    return DeterministicChiefDecision().conclude(
        hypothesis_set, opinions, falsification, confidence
    )


def test_clear_winner_is_chosen_with_rationale(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    opinions = tuple(
        opinion_factory(role, hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.HIGH)})
        for role in ("a", "b")
    )
    conclusion = _decide(hypothesis_set, opinions)

    assert conclusion.chosen.statement == "the bearing is worn"
    assert not conclusion.is_inaction
    assert "highest synthesized confidence" in conclusion.rationale


def test_weak_conviction_chooses_inaction(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    weak = opinion_factory(
        "lukewarm", hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.LOW)}
    )
    opposition = opinion_factory(
        "skeptic", hypothesis_set, {"the bearing": (Stance.OPPOSES, Confidence.VERY_HIGH)}
    )
    conclusion = _decide(hypothesis_set, (weak, opposition))

    assert conclusion.is_inaction
    assert "CC §6" in conclusion.rationale


def test_tie_between_actionable_hypotheses_chooses_inaction(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    opinions = (
        opinion_factory("a", hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.HIGH)}),
        opinion_factory("b", hypothesis_set, {"the shaft": (Stance.SUPPORTS, Confidence.HIGH)}),
    )
    conclusion = _decide(hypothesis_set, opinions)

    assert conclusion.is_inaction
    assert "tie" in conclusion.rationale


def test_severe_challenge_on_leader_demotes_to_inaction(
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
        objection="the sensor feed was interrupted mid-capture",
        severity=ChallengeSeverity.SEVERE,
    )
    conclusion = _decide(hypothesis_set, opinions, (challenge,))

    assert conclusion.is_inaction, "a severely challenged leader must not be acted on"


def test_standing_challenges_travel_with_the_conclusion(
    hypothesis_set: HypothesisSet, opinion_factory: OpinionFactory
) -> None:
    inaction_id = hypothesis_set.inaction.hypothesis_id
    challenge = Challenge(
        hypothesis_id=inaction_id,
        objection="waiting has a cost: the machine degrades further",
        severity=ChallengeSeverity.MINOR,
    )
    weak = opinion_factory(
        "lukewarm", hypothesis_set, {"the bearing": (Stance.SUPPORTS, Confidence.LOW)}
    )
    opposition = opinion_factory(
        "skeptic", hypothesis_set, {"the bearing": (Stance.OPPOSES, Confidence.VERY_HIGH)}
    )
    conclusion = _decide(hypothesis_set, (weak, opposition), (challenge,))

    assert conclusion.is_inaction
    assert conclusion.standing_challenges == (challenge,)
