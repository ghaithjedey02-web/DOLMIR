from collections.abc import Callable

import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.hypothesis import Hypothesis, HypothesisSet

HypothesisFactory = Callable[..., Hypothesis]


def test_hypothesis_without_falsification_condition_is_unconstructible() -> None:
    with pytest.raises(ValueError, match="falsification_condition"):
        Hypothesis(
            hypothesis_id=EntityId.generate(),
            statement="something will happen",
            falsification_condition="   ",
        )


def test_set_requires_at_least_two_members(hypothesis_factory: HypothesisFactory) -> None:
    with pytest.raises(ValueError, match="at least two"):
        HypothesisSet(members=(hypothesis_factory(inaction=True),))


def test_set_without_inaction_option_is_unconstructible(
    hypothesis_factory: HypothesisFactory,
) -> None:
    with pytest.raises(ValueError, match="exactly one inaction"):
        HypothesisSet(members=(hypothesis_factory("a"), hypothesis_factory("b")))


def test_set_with_two_inaction_options_is_unconstructible(
    hypothesis_factory: HypothesisFactory,
) -> None:
    with pytest.raises(ValueError, match="exactly one inaction"):
        HypothesisSet(
            members=(
                hypothesis_factory("a", inaction=True),
                hypothesis_factory("b", inaction=True),
            )
        )


def test_duplicate_ids_rejected(hypothesis_factory: HypothesisFactory) -> None:
    member = hypothesis_factory("a")
    duplicate = Hypothesis(
        hypothesis_id=member.hypothesis_id,
        statement="b",
        falsification_condition="x happens",
        represents_inaction=True,
    )
    with pytest.raises(ValueError, match="unique"):
        HypothesisSet(members=(member, duplicate))


def test_inaction_accessor_and_lookup(hypothesis_set: HypothesisSet) -> None:
    assert hypothesis_set.inaction.represents_inaction
    first = hypothesis_set.members[0]
    assert hypothesis_set.get(first.hypothesis_id) is first
    assert len(hypothesis_set.ids()) == 3


def test_lookup_of_unknown_id_raises(hypothesis_set: HypothesisSet) -> None:
    with pytest.raises(KeyError):
        hypothesis_set.get(EntityId.generate())
