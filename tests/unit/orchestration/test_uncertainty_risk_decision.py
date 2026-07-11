import pytest

from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.decision import (
    Decision,
    IdentifiedRisk,
    RiskAssessment,
    RiskMagnitude,
)
from dolmir.orchestration.trace.hypothesis import HypothesisSet
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind


def _conclusion(hypothesis_set: HypothesisSet, *, inaction: bool) -> Conclusion:
    chosen = hypothesis_set.inaction if inaction else hypothesis_set.members[0]
    return Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.HIGH, basis="test basis"
        ),
        rationale="test rationale",
    )


def test_epistemic_uncertainty_requires_resolution() -> None:
    with pytest.raises(ValueError, match="must name what will resolve it"):
        Uncertainty(kind=UncertaintyKind.EPISTEMIC, description="pending measurement")


def test_aleatory_uncertainty_forbids_resolution() -> None:
    with pytest.raises(ValueError, match="irreducible"):
        Uncertainty(
            kind=UncertaintyKind.ALEATORY,
            description="inherent process noise",
            resolution="wait for it",
        )


def test_both_uncertainty_kinds_construct_correctly() -> None:
    epistemic = Uncertainty(
        kind=UncertaintyKind.EPISTEMIC,
        description="alignment not yet measured",
        resolution="laser alignment check scheduled",
    )
    aleatory = Uncertainty(kind=UncertaintyKind.ALEATORY, description="load variation is random")
    assert epistemic.resolution is not None
    assert aleatory.resolution is None


def test_conclusion_carries_open_uncertainties(hypothesis_set: HypothesisSet) -> None:
    chosen = hypothesis_set.members[0]
    conclusion = Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.MODERATE, basis="b"
        ),
        rationale="r",
        open_uncertainties=(
            Uncertainty(kind=UncertaintyKind.ALEATORY, description="process noise"),
        ),
    )
    assert len(conclusion.open_uncertainties) == 1


def test_identified_risk_validation() -> None:
    with pytest.raises(ValueError, match="description"):
        IdentifiedRisk(description=" ", magnitude=RiskMagnitude.LOW)
    with pytest.raises(ValueError, match="mitigation"):
        IdentifiedRisk(description="x", magnitude=RiskMagnitude.LOW, mitigation="  ")


def test_acceptable_assessment_with_unmitigated_critical_risk_is_contradictory() -> None:
    critical = IdentifiedRisk(description="total loss possible", magnitude=RiskMagnitude.CRITICAL)
    with pytest.raises(ValueError, match="unmitigated CRITICAL"):
        RiskAssessment(risks=(critical,), acceptable=True, basis="looks fine")


def test_mitigated_critical_risk_can_be_acceptable() -> None:
    mitigated = IdentifiedRisk(
        description="total loss possible",
        magnitude=RiskMagnitude.CRITICAL,
        mitigation="hard stop at threshold",
    )
    assessment = RiskAssessment(risks=(mitigated,), acceptable=True, basis="mitigated")
    assert assessment.acceptable


def test_action_over_unacceptable_risk_is_unconstructible(
    hypothesis_set: HypothesisSet,
) -> None:
    unacceptable = RiskAssessment(risks=(), acceptable=False, basis="limits exceeded")
    with pytest.raises(ValueError, match="structural, not advisory"):
        Decision(
            conclusion=_conclusion(hypothesis_set, inaction=False),
            risk=unacceptable,
            action="proceed with repair",
        )


def test_inaction_is_always_permitted_regardless_of_risk(
    hypothesis_set: HypothesisSet,
) -> None:
    unacceptable = RiskAssessment(risks=(), acceptable=False, basis="limits exceeded")
    decision = Decision(
        conclusion=_conclusion(hypothesis_set, inaction=True),
        risk=unacceptable,
        action="continue monitoring only",
    )
    assert decision.conclusion.is_inaction


def test_action_with_acceptable_risk_constructs(hypothesis_set: HypothesisSet) -> None:
    acceptable = RiskAssessment(risks=(), acceptable=True, basis="within all limits")
    decision = Decision(
        conclusion=_conclusion(hypothesis_set, inaction=False),
        risk=acceptable,
        action="schedule bearing replacement",
    )
    assert decision.action.startswith("schedule")
