import pytest

from dolmir.orchestration.trace.epistemic import (
    Claim,
    EpistemicStatus,
    Evidence,
    EvidenceKind,
)


def test_fact_requires_citation_or_computation_grounding() -> None:
    with pytest.raises(ValueError, match="FACT claim requires"):
        Claim(statement="bearings wear out", status=EpistemicStatus.FACT)


def test_fact_with_only_observation_evidence_is_rejected(
    observation_evidence: Evidence,
) -> None:
    with pytest.raises(ValueError, match="FACT claim requires"):
        Claim(
            statement="bearings wear out",
            status=EpistemicStatus.FACT,
            evidence=(observation_evidence,),
        )


def test_fact_with_citation_constructs(citation_evidence: Evidence) -> None:
    claim = Claim(
        statement="2x harmonics indicate bearing wear",
        status=EpistemicStatus.FACT,
        evidence=(citation_evidence,),
    )
    assert claim.status is EpistemicStatus.FACT


def test_fact_with_computation_constructs() -> None:
    computed = Evidence(
        kind=EvidenceKind.COMPUTATION,
        source_ref="fft_peak_detector",
        content="dominant peak at 2.02x shaft speed",
    )
    claim = Claim(
        statement="the dominant vibration peak sits at twice shaft speed",
        status=EpistemicStatus.FACT,
        evidence=(computed,),
    )
    assert claim.evidence == (computed,)


def test_observation_requires_observation_evidence(citation_evidence: Evidence) -> None:
    with pytest.raises(ValueError, match="OBSERVATION claim requires"):
        Claim(
            statement="vibration observed at 2x",
            status=EpistemicStatus.OBSERVATION,
            evidence=(citation_evidence,),
        )


def test_assumption_and_hypothesis_need_no_evidence() -> None:
    assumption = Claim(
        statement="this looks like early-stage wear", status=EpistemicStatus.ASSUMPTION
    )
    hypothesis = Claim(
        statement="the machine will trip within a week", status=EpistemicStatus.HYPOTHESIS
    )
    assert assumption.evidence == ()
    assert hypothesis.evidence == ()


def test_empty_statement_rejected() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        Claim(statement="  ", status=EpistemicStatus.ASSUMPTION)


def test_untraceable_evidence_rejected() -> None:
    with pytest.raises(ValueError, match="source_ref"):
        Evidence(kind=EvidenceKind.CITATION, source_ref=" ", content="something")
    with pytest.raises(ValueError, match="content"):
        Evidence(kind=EvidenceKind.CITATION, source_ref="doc:1", content=" ")
