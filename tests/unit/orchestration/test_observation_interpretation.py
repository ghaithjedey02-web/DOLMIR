from datetime import datetime

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus
from dolmir.orchestration.trace.observation import (
    Interpretation,
    Observation,
    ObservationSet,
)


def _observation(moment: datetime, source: str = "sensor:vibration-01") -> Observation:
    return Observation(
        observation_id=EntityId.generate(),
        source_ref=source,
        content="vibration at 2x shaft speed",
        observed_at=moment,
    )


def test_observation_requires_traceable_source_and_content(moment: datetime) -> None:
    with pytest.raises(ValueError, match="source_ref"):
        Observation(
            observation_id=EntityId.generate(),
            source_ref="  ",
            content="x",
            observed_at=moment,
        )
    with pytest.raises(ValueError, match="content"):
        Observation(
            observation_id=EntityId.generate(),
            source_ref="sensor:1",
            content="  ",
            observed_at=moment,
        )


def test_observation_rejects_naive_timestamp() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        Observation(
            observation_id=EntityId.generate(),
            source_ref="sensor:1",
            content="x",
            observed_at=datetime(2026, 7, 9, 12, 0),
        )


def test_observation_set_rejects_empty_and_duplicates(moment: datetime) -> None:
    with pytest.raises(ValueError, match="at least one"):
        ObservationSet(members=())
    duplicate = _observation(moment)
    with pytest.raises(ValueError, match="unique"):
        ObservationSet(members=(duplicate, duplicate))


def test_observation_set_ids(moment: datetime) -> None:
    observations = ObservationSet(members=(_observation(moment), _observation(moment, "s:2")))
    assert len(observations.ids()) == 2


def test_interpretation_requires_claims_and_provenance(moment: datetime) -> None:
    observation = _observation(moment)
    claim = Claim(statement="looks like early wear", status=EpistemicStatus.ASSUMPTION)
    with pytest.raises(ValueError, match="at least one claim"):
        Interpretation(claims=(), interpreted_from=frozenset({observation.observation_id}))
    with pytest.raises(ValueError, match="fabrication"):
        Interpretation(claims=(claim,), interpreted_from=frozenset())


def test_interpretation_constructs_with_provenance(moment: datetime) -> None:
    observation = _observation(moment)
    claim = Claim(statement="looks like early wear", status=EpistemicStatus.ASSUMPTION)
    interpretation = Interpretation(
        claims=(claim,), interpreted_from=frozenset({observation.observation_id})
    )
    assert observation.observation_id in interpretation.interpreted_from
