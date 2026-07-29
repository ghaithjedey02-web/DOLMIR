from dataclasses import dataclass
from datetime import UTC, datetime

import structlog.testing

from dolmir.kernel.event_bus import InMemoryEventBus, IntegrationEvent
from dolmir.kernel.shared_kernel import EntityId

_MOMENT = datetime(2026, 7, 9, 12, 0, tzinfo=UTC)


@dataclass(frozen=True, kw_only=True, slots=True)
class AnalysisCompleted(IntegrationEvent):
    symbol: str


@dataclass(frozen=True, kw_only=True, slots=True)
class DetailedAnalysisCompleted(AnalysisCompleted):
    detail: str


def _event(symbol: str = "EURUSD") -> AnalysisCompleted:
    return AnalysisCompleted(event_id=EntityId.generate(), occurred_at=_MOMENT, symbol=symbol)


async def test_subscriber_receives_published_event() -> None:
    bus = InMemoryEventBus()
    received: list[AnalysisCompleted] = []

    async def handler(event: AnalysisCompleted) -> None:
        received.append(event)

    bus.subscribe(AnalysisCompleted, handler)
    event = _event()
    await bus.publish(event)

    assert received == [event]


async def test_all_matching_subscribers_receive_the_event() -> None:
    bus = InMemoryEventBus()
    seen: list[str] = []

    async def first(_: AnalysisCompleted) -> None:
        seen.append("first")

    async def second(_: AnalysisCompleted) -> None:
        seen.append("second")

    bus.subscribe(AnalysisCompleted, first)
    bus.subscribe(AnalysisCompleted, second)
    await bus.publish(_event())

    assert seen == ["first", "second"]


async def test_subclass_events_reach_base_type_subscribers() -> None:
    bus = InMemoryEventBus()
    received: list[AnalysisCompleted] = []

    async def handler(event: AnalysisCompleted) -> None:
        received.append(event)

    bus.subscribe(AnalysisCompleted, handler)
    subclass_event = DetailedAnalysisCompleted(
        event_id=EntityId.generate(), occurred_at=_MOMENT, symbol="EURUSD", detail="x"
    )
    await bus.publish(subclass_event)

    assert received == [subclass_event]


async def test_unrelated_event_types_are_not_delivered() -> None:
    bus = InMemoryEventBus()
    received: list[DetailedAnalysisCompleted] = []

    async def handler(event: DetailedAnalysisCompleted) -> None:
        received.append(event)

    bus.subscribe(DetailedAnalysisCompleted, handler)
    await bus.publish(_event())  # base type, not the subscribed subclass

    assert received == []


async def test_publish_with_no_subscribers_is_a_noop() -> None:
    await InMemoryEventBus().publish(_event())


async def test_failing_handler_is_isolated_and_logged() -> None:
    bus = InMemoryEventBus()
    received: list[AnalysisCompleted] = []

    async def broken(_: AnalysisCompleted) -> None:
        msg = "subscriber bug"
        raise RuntimeError(msg)

    async def healthy(event: AnalysisCompleted) -> None:
        received.append(event)

    bus.subscribe(AnalysisCompleted, broken)
    bus.subscribe(AnalysisCompleted, healthy)

    event = _event()
    with structlog.testing.capture_logs() as logs:
        await bus.publish(event)

    assert received == [event], "healthy handler must still receive the event"
    failures = [entry for entry in logs if entry["log_level"] == "error"]
    assert len(failures) == 1
    assert failures[0]["event_type"] == "AnalysisCompleted"
