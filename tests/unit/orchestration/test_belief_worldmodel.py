from datetime import datetime, timedelta

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.belief import Belief, WorldModel
from dolmir.orchestration.trace.epistemic import Claim, EpistemicStatus


def _assumption_claim(statement: str = "this machine runs hot under load") -> Claim:
    return Claim(statement=statement, status=EpistemicStatus.ASSUMPTION)


def _belief(moment: datetime, *, supersedes: EntityId | None = None) -> Belief:
    return Belief(
        belief_id=EntityId.generate(),
        claim=_assumption_claim(),
        formed_at=moment,
        derived_from=(EntityId.generate(),),
        supersedes=supersedes,
    )


def test_belief_without_provenance_is_unconstructible(moment: datetime) -> None:
    with pytest.raises(ValueError, match="provenance"):
        Belief(
            belief_id=EntityId.generate(),
            claim=_assumption_claim(),
            formed_at=moment,
            derived_from=(),
        )


def test_belief_cannot_hold_a_hypothesis(moment: datetime) -> None:
    hypothesis_claim = Claim(statement="it will trip next week", status=EpistemicStatus.HYPOTHESIS)
    with pytest.raises(ValueError, match="per-run candidates"):
        Belief(
            belief_id=EntityId.generate(),
            claim=hypothesis_claim,
            formed_at=moment,
            derived_from=(EntityId.generate(),),
        )


def test_belief_cannot_supersede_itself(moment: datetime) -> None:
    belief_id = EntityId.generate()
    with pytest.raises(ValueError, match="supersede itself"):
        Belief(
            belief_id=belief_id,
            claim=_assumption_claim(),
            formed_at=moment,
            derived_from=(EntityId.generate(),),
            supersedes=belief_id,
        )


def test_world_model_holds_and_looks_up_beliefs(moment: datetime) -> None:
    belief = _belief(moment)
    model = WorldModel(
        model_id=EntityId.generate(), subject="machine-07", as_of=moment, beliefs=(belief,)
    )
    assert model.belief(belief.belief_id) is belief
    with pytest.raises(KeyError):
        model.belief(EntityId.generate())


def test_world_model_rejects_duplicate_belief_ids(moment: datetime) -> None:
    belief = _belief(moment)
    with pytest.raises(ValueError, match="unique"):
        WorldModel(
            model_id=EntityId.generate(),
            subject="machine-07",
            as_of=moment,
            beliefs=(belief, belief),
        )


def test_revision_retires_the_superseded_belief(moment: datetime) -> None:
    original = _belief(moment)
    model = WorldModel(
        model_id=EntityId.generate(), subject="machine-07", as_of=moment, beliefs=(original,)
    )
    later = moment + timedelta(days=1)
    replacement = _belief(later, supersedes=original.belief_id)

    revised = model.revised(replacement, as_of=later)

    assert revised is not model, "revision must produce a new model, not mutate"
    assert revised.as_of == later
    assert replacement.belief_id in {held.belief_id for held in revised.beliefs}
    assert original.belief_id not in {held.belief_id for held in revised.beliefs}
    assert model.belief(original.belief_id) is original, "history stays reconstructable"


def test_revision_of_an_unheld_belief_is_a_wiring_bug(moment: datetime) -> None:
    model = WorldModel(model_id=EntityId.generate(), subject="machine-07", as_of=moment)
    stray = _belief(moment, supersedes=EntityId.generate())
    with pytest.raises(ValueError, match="does not hold"):
        model.revised(stray, as_of=moment)


def test_additive_revision_keeps_existing_beliefs(moment: datetime) -> None:
    first = _belief(moment)
    model = WorldModel(
        model_id=EntityId.generate(), subject="machine-07", as_of=moment, beliefs=(first,)
    )
    second = _belief(moment)

    revised = model.revised(second, as_of=moment)

    held_ids = {held.belief_id for held in revised.beliefs}
    assert held_ids == {first.belief_id, second.belief_id}
