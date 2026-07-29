from dataclasses import dataclass

import pytest

from dolmir.kernel.shared_kernel import Ok, Result
from dolmir.orchestration.failure import FailurePolicy, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.graph.graph import GraphValidationError, ReasoningGraph
from dolmir.orchestration.graph.node import NodeReport
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import ConfidenceReport
from dolmir.orchestration.trace.opinion import AgentOpinion


@dataclass(frozen=True)
class Alpha:
    value: int = 0


@dataclass(frozen=True)
class Beta:
    value: int = 0


class StubNode:
    """Minimal configurable node for assembly tests."""

    def __init__(
        self,
        name: str,
        *,
        requires: frozenset[type[object]] = frozenset(),
        produces: frozenset[type[object]] = frozenset(),
    ) -> None:
        self._name = name
        self._requires = requires
        self._produces = produces

    @property
    def name(self) -> str:
        return self._name

    @property
    def requires(self) -> frozenset[type[object]]:
        return self._requires

    @property
    def produces(self) -> frozenset[type[object]]:
        return self._produces

    @property
    def failure_policy(self) -> FailurePolicy:
        return FailurePolicy.ABORT_RUN

    async def run(self, context: GraphContext) -> Result[NodeReport, NodeFailure]:
        return Ok(NodeReport())


def test_duplicate_node_names_rejected() -> None:
    with pytest.raises(GraphValidationError, match="duplicate node names"):
        ReasoningGraph((StubNode("same"), StubNode("same")))


def test_two_producers_of_write_once_type_rejected() -> None:
    with pytest.raises(GraphValidationError, match="multiple producers"):
        ReasoningGraph(
            (
                StubNode("a", produces=frozenset({Alpha})),
                StubNode("b", produces=frozenset({Alpha})),
            )
        )


def test_multiple_opinion_producers_are_allowed() -> None:
    graph = ReasoningGraph(
        (
            StubNode("a", produces=frozenset({AgentOpinion})),
            StubNode("b", produces=frozenset({AgentOpinion})),
        )
    )
    assert len(graph.producers_of(AgentOpinion)) == 2


def test_unsatisfiable_requirement_rejected() -> None:
    with pytest.raises(GraphValidationError, match="requires Alpha"):
        ReasoningGraph((StubNode("needy", requires=frozenset({Alpha})),))


def test_seeded_types_satisfy_requirements() -> None:
    graph = ReasoningGraph(
        (StubNode("needy", requires=frozenset({Alpha})),),
        seed_types=frozenset({Alpha}),
    )
    assert graph.waves == ((graph.nodes[0],),)


def test_type_both_seeded_and_produced_rejected() -> None:
    with pytest.raises(GraphValidationError, match="both seeded and produced"):
        ReasoningGraph(
            (StubNode("producer", produces=frozenset({Alpha})),),
            seed_types=frozenset({Alpha}),
        )


def test_cycle_detected() -> None:
    with pytest.raises(GraphValidationError, match="cycle"):
        ReasoningGraph(
            (
                StubNode("a", requires=frozenset({Beta}), produces=frozenset({Alpha})),
                StubNode("b", requires=frozenset({Alpha}), produces=frozenset({Beta})),
            )
        )


def test_waves_are_dependency_ordered_and_name_sorted() -> None:
    producer = StubNode("producer", produces=frozenset({Alpha}))
    consumer_b = StubNode("b_consumer", requires=frozenset({Alpha}))
    consumer_a = StubNode("a_consumer", requires=frozenset({Alpha}))
    independent = StubNode("independent")

    graph = ReasoningGraph((consumer_b, producer, independent, consumer_a))

    first_wave_names = [node.name for node in graph.waves[0]]
    second_wave_names = [node.name for node in graph.waves[1]]
    assert first_wave_names == ["independent", "producer"]
    assert second_wave_names == ["a_consumer", "b_consumer"]


def test_constitutional_gate_deciding_without_falsification_fails_assembly() -> None:
    rogue_decider = StubNode(
        "rogue",
        requires=frozenset({ConfidenceReport}),
        produces=frozenset({Conclusion}),
    )
    confidence_stub = StubNode("conf", produces=frozenset({ConfidenceReport}))
    with pytest.raises(GraphValidationError, match="structurally forbidden"):
        ReasoningGraph((rogue_decider, confidence_stub))


def test_constitutional_gate_satisfied_decider_assembles() -> None:
    decider = StubNode(
        "decider",
        requires=frozenset({FalsificationReport, ConfidenceReport}),
        produces=frozenset({Conclusion}),
    )
    falsifier = StubNode("falsifier", produces=frozenset({FalsificationReport}))
    confidence = StubNode("confidence", produces=frozenset({ConfidenceReport}))
    graph = ReasoningGraph((decider, falsifier, confidence))
    assert [node.name for node in graph.waves[-1]] == ["decider"]
