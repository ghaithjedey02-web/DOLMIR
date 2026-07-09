"""Shared fixtures for reasoning-engine tests.

The test domain is deliberately NOT trading: a machine-fault diagnosis
scenario proves the engine is domain-agnostic (Phase 2A exit criterion).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import pytest

from dolmir.kernel.clock import FixedClock
from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.confidence import Confidence
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet
from dolmir.orchestration.trace.opinion import AgentOpinion, HypothesisAssessment, Stance

MOMENT = datetime(2026, 7, 9, 12, 0, tzinfo=UTC)

HypothesisFactory = Callable[..., Hypothesis]
OpinionFactory = Callable[[str, HypothesisSet, dict[str, tuple[Stance, Confidence]]], AgentOpinion]


@pytest.fixture
def moment() -> datetime:
    return MOMENT


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock(MOMENT)


@pytest.fixture
def hypothesis_factory() -> HypothesisFactory:
    def factory(
        statement: str = "the bearing is worn",
        *,
        falsification: str = "vibration spectrum shows no 2x harmonic",
        inaction: bool = False,
    ) -> Hypothesis:
        return Hypothesis(
            hypothesis_id=EntityId.generate(),
            statement=statement,
            falsification_condition=falsification,
            represents_inaction=inaction,
        )

    return factory


@pytest.fixture
def hypothesis_set(hypothesis_factory: HypothesisFactory) -> HypothesisSet:
    return HypothesisSet(
        members=(
            hypothesis_factory("the bearing is worn"),
            hypothesis_factory(
                "the shaft is misaligned",
                falsification="laser alignment check reads within tolerance",
            ),
            hypothesis_factory(
                "insufficient signal to diagnose; gather more data",
                falsification="a fault signature emerges in any later measurement",
                inaction=True,
            ),
        )
    )


@pytest.fixture
def observation_evidence() -> Evidence:
    return Evidence(
        kind=EvidenceKind.OBSERVATION,
        source_ref="sensor:vibration-01",
        content="vibration at 2x shaft speed",
    )


@pytest.fixture
def citation_evidence() -> Evidence:
    return Evidence(
        kind=EvidenceKind.CITATION,
        source_ref="doctrine:vibration-analysis@v1",
        content="2x harmonics indicate bearing wear",
    )


@pytest.fixture
def opinion_factory(observation_evidence: Evidence) -> OpinionFactory:
    def factory(
        role: str,
        hypotheses: HypothesisSet,
        stances: dict[str, tuple[Stance, Confidence]],
    ) -> AgentOpinion:
        assessments = []
        for member in hypotheses:
            for prefix, (stance, confidence) in stances.items():
                if member.statement.startswith(prefix):
                    assessments.append(
                        HypothesisAssessment(
                            hypothesis_id=member.hypothesis_id,
                            stance=stance,
                            confidence=confidence,
                            reasoning=f"{role} judged {member.statement!r}: {stance.value}",
                            evidence=(observation_evidence,),
                        )
                    )
        return AgentOpinion(role=role, strategy_version="test-v1", assessments=tuple(assessments))

    return factory
