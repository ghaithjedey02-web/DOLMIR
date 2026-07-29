"""ReasoningGraph: validated assembly of nodes into an executable DAG.

Validation happens at assembly, not at run time: an ill-formed graph (a
cycle, two producers of one write-once type, an unsatisfiable requirement)
is a programming error surfaced before any reasoning starts — loudly, at
boot, per Core Architecture §16.
"""

from __future__ import annotations

from dataclasses import dataclass
from graphlib import CycleError, TopologicalSorter

from dolmir.orchestration.graph.node import GraphNode
from dolmir.orchestration.trace.challenge import FalsificationReport
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import ConfidenceReport
from dolmir.orchestration.trace.opinion import AgentOpinion

__all__ = ["GraphValidationError", "ReasoningGraph"]


class GraphValidationError(ValueError):
    """The node set cannot form a valid reasoning graph."""


@dataclass(frozen=True, slots=True)
class _Plan:
    """Precomputed execution structure: waves of concurrently-runnable nodes."""

    waves: tuple[tuple[GraphNode, ...], ...]
    producers_by_type: dict[type[object], tuple[GraphNode, ...]]


class ReasoningGraph:
    """An immutable, validated set of nodes with derived typed edges.

    Edges are never declared — they are derived: node B depends on node A
    exactly when A produces a type B requires. ``AgentOpinion`` is the one
    type allowed multiple producers (debate is many voices — Cognitive
    Architecture §3 stage 6); a node requiring ``AgentOpinion`` therefore
    depends on *all* opinion producers, which is precisely the fan-in a
    synthesis stage wants.
    """

    def __init__(
        self, nodes: tuple[GraphNode, ...], *, seed_types: frozenset[type[object]] = frozenset()
    ) -> None:
        """Assemble and validate.

        Args:
            nodes: The reasoning stages, in any order — ordering is derived.
            seed_types: Artifact types the caller will provide to the
                context before execution (the run's external inputs).

        Raises:
            GraphValidationError: On duplicate node names, duplicate
                producers of a write-once type, requirements nothing
                satisfies, or dependency cycles.
        """
        self._nodes = nodes
        self._seed_types = seed_types
        self._plan = self._validate_and_plan()

    @property
    def nodes(self) -> tuple[GraphNode, ...]:
        """The graph's nodes."""
        return self._nodes

    @property
    def seed_types(self) -> frozenset[type[object]]:
        """Artifact types the caller must seed before execution."""
        return self._seed_types

    @property
    def waves(self) -> tuple[tuple[GraphNode, ...], ...]:
        """Ordered execution waves.

        Nodes within a wave are independent and run concurrently; waves run
        in order. Deterministic: nodes within a wave are sorted by name.
        """
        return self._plan.waves

    def producers_of(self, artifact_type: type[object]) -> tuple[GraphNode, ...]:
        """All nodes that declare producing ``artifact_type``."""
        return self._plan.producers_by_type.get(artifact_type, ())

    def _validate_and_plan(self) -> _Plan:
        """Run all assembly-time checks and precompute the execution waves."""
        self._check_unique_names()
        producers = self._collect_and_check_producers()
        self._check_requirements_satisfiable(producers)
        self._check_constitutional_gate(producers)
        return _Plan(
            waves=self._compute_waves(producers),
            producers_by_type={produced: tuple(nodes) for produced, nodes in producers.items()},
        )

    def _check_unique_names(self) -> None:
        """Reject duplicate node names — they must be stable trace keys."""
        names = [node.name for node in self._nodes]
        if len(set(names)) != len(names):
            duplicates = sorted({name for name in names if names.count(name) > 1})
            msg = f"duplicate node names: {duplicates}"
            raise GraphValidationError(msg)

    def _collect_and_check_producers(self) -> dict[type[object], list[GraphNode]]:
        """Index producers by type; enforce write-once and seed exclusivity."""
        producers: dict[type[object], list[GraphNode]] = {}
        for node in self._nodes:
            for produced in node.produces:
                producers.setdefault(produced, []).append(node)

        for produced, producing_nodes in producers.items():
            if produced is not AgentOpinion and len(producing_nodes) > 1:
                offender_names = sorted(node.name for node in producing_nodes)
                msg = (
                    f"multiple producers of write-once type {produced.__name__}: "
                    f"{offender_names} (only AgentOpinion accumulates)"
                )
                raise GraphValidationError(msg)
            if produced in self._seed_types:
                offender_names = sorted(node.name for node in producing_nodes)
                msg = (
                    f"type {produced.__name__} is both seeded and produced by "
                    f"{offender_names}; seeded types are external inputs"
                )
                raise GraphValidationError(msg)
        return producers

    def _check_requirements_satisfiable(
        self, producers: dict[type[object], list[GraphNode]]
    ) -> None:
        """Every required type must come from a seed or some node."""
        for node in self._nodes:
            for required in node.requires:
                if required not in self._seed_types and required not in producers:
                    msg = (
                        f"node {node.name!r} requires {required.__name__}, which "
                        "no seed or node provides"
                    )
                    raise GraphValidationError(msg)

    def _check_constitutional_gate(self, producers: dict[type[object], list[GraphNode]]) -> None:
        """CC §9 / CogA §3 stages 7-8, made structural.

        Any node that produces a Conclusion must consume a
        FalsificationReport and a ConfidenceReport. A deciding graph that
        skips adversarial falsification or confidence synthesis is not
        merely discouraged — it cannot be assembled.
        """
        for node in producers.get(Conclusion, []):
            missing_gates = sorted(
                gate.__name__
                for gate in (FalsificationReport, ConfidenceReport)
                if gate not in node.requires
            )
            if missing_gates:
                msg = (
                    f"node {node.name!r} produces Conclusion but does not require "
                    f"{missing_gates}: deciding without falsification and "
                    "confidence synthesis violates Cognitive Constitution §9 "
                    "and is structurally forbidden"
                )
                raise GraphValidationError(msg)

    def _compute_waves(
        self, producers: dict[type[object], list[GraphNode]]
    ) -> tuple[tuple[GraphNode, ...], ...]:
        """Topologically sort derived edges into deterministic waves."""
        by_name = {node.name: node for node in self._nodes}
        sorter: TopologicalSorter[str] = TopologicalSorter()
        for node in self._nodes:
            dependency_names = sorted(
                {
                    producer.name
                    for required in node.requires
                    for producer in producers.get(required, [])
                    if producer.name != node.name
                }
            )
            sorter.add(node.name, *dependency_names)

        try:
            sorter.prepare()
        except CycleError as exc:
            msg = f"dependency cycle among nodes: {exc.args[1]}"
            raise GraphValidationError(msg) from exc

        waves: list[tuple[GraphNode, ...]] = []
        while sorter.is_active():
            ready = sorted(sorter.get_ready())
            waves.append(tuple(by_name[name] for name in ready))
            sorter.done(*ready)
        return tuple(waves)
