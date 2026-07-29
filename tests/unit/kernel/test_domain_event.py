import dataclasses
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import ClassVar

import pytest

from dolmir.kernel.shared_kernel import DomainEvent, EntityId

_AWARE_MOMENT = datetime(2026, 7, 9, 12, 0, tzinfo=UTC)


@dataclass(frozen=True, kw_only=True, slots=True)
class SomethingHappened(DomainEvent):
    detail: str


@dataclass(frozen=True, kw_only=True, slots=True)
class SomethingHappenedV2(DomainEvent):
    schema_version: ClassVar[int] = 2
    detail: str


def test_subclass_carries_payload_and_base_fields() -> None:
    event = SomethingHappened(event_id=EntityId.generate(), occurred_at=_AWARE_MOMENT, detail="x")
    assert event.detail == "x"
    assert event.occurred_at == _AWARE_MOMENT


def test_events_are_immutable() -> None:
    event = SomethingHappened(event_id=EntityId.generate(), occurred_at=_AWARE_MOMENT, detail="x")
    with pytest.raises(dataclasses.FrozenInstanceError):
        event.detail = "y"  # type: ignore[misc]


def test_naive_timestamp_is_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        SomethingHappened(
            event_id=EntityId.generate(),
            occurred_at=datetime(2026, 7, 9, 12, 0),
            detail="x",
        )


def test_schema_version_defaults_to_one_and_is_overridable() -> None:
    assert SomethingHappened.schema_version == 1
    assert SomethingHappenedV2.schema_version == 2
    event = SomethingHappenedV2(event_id=EntityId.generate(), occurred_at=_AWARE_MOMENT, detail="x")
    assert type(event).schema_version == 2
