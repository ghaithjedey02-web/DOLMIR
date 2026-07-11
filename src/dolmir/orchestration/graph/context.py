"""GraphContext: one run's working memory.

Cognitive Architecture §11 places working memory here deliberately — it is
Orchestration's ephemeral execution state, not Memory Engine's concern.
Artifacts are indexed by *type*: a node declares what data types it needs,
never which node produces them, which is what keeps nodes decoupled and
independently testable (Core Architecture §8).

Mutation discipline: nodes only *read* the context. All writes go through
the executor, which records exactly what each node produced into the trace
— a node cannot smuggle state past the audit record.
"""

from __future__ import annotations

from typing import cast

from dolmir.kernel.clock import ClockPort
from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.opinion import AgentOpinion

__all__ = ["DuplicateArtifactError", "GraphContext", "MissingArtifactError"]


class MissingArtifactError(LookupError):
    """A required artifact type has not been produced (or was seeded absent)."""


class DuplicateArtifactError(ValueError):
    """A second artifact of a write-once type was produced."""


class GraphContext:
    """Typed, write-once artifact store for a single reasoning run.

    ``AgentOpinion`` is the one deliberately *accumulating* type — debate
    means several nodes each contribute one (Cognitive Architecture §3
    stage 6) — exposed as an ordered tuple via :meth:`opinions`. Every
    other artifact type is write-once: two nodes producing the same type
    is an assembly error, caught before any run starts.
    """

    def __init__(self, *, run_id: EntityId, clock: ClockPort) -> None:
        """Create the context for one run.

        Args:
            run_id: Identity shared by the run, its trace, and its logs
                (Core Architecture §17, correlation).
            clock: The run's injected time source (Standing Rule 7).
        """
        self._run_id = run_id
        self._clock = clock
        self._artifacts: dict[type[object], object] = {}
        self._opinions: list[AgentOpinion] = []

    @property
    def run_id(self) -> EntityId:
        """The run's correlation identity."""
        return self._run_id

    @property
    def clock(self) -> ClockPort:
        """The run's injected time source."""
        return self._clock

    def get[A](self, artifact_type: type[A]) -> A:
        """Return the artifact of ``artifact_type``.

        Raises:
            MissingArtifactError: If nothing of that type exists yet.
        """
        try:
            value = self._artifacts[artifact_type]
        except KeyError:
            msg = (
                f"no artifact of type {artifact_type.__name__} in this run's "
                "context — either its producer has not run, was skipped, or "
                "the graph was assembled without one"
            )
            raise MissingArtifactError(msg) from None
        return cast("A", value)

    def has(self, artifact_type: type[object]) -> bool:
        """Whether an artifact of ``artifact_type`` exists."""
        return artifact_type in self._artifacts

    def opinions(self) -> tuple[AgentOpinion, ...]:
        """All opinions contributed so far, in deterministic arrival order."""
        return tuple(self._opinions)

    def _store(self, artifact: object) -> None:
        """Executor-only write path.

        ``AgentOpinion`` accumulates; every other exact type is write-once.

        Raises:
            DuplicateArtifactError: On a second artifact of a write-once type.
        """
        if isinstance(artifact, AgentOpinion):
            self._opinions.append(artifact)
            return
        exact_type = type(artifact)
        if exact_type in self._artifacts:
            msg = (
                f"an artifact of type {exact_type.__name__} already exists; "
                "artifact types are write-once within a run"
            )
            raise DuplicateArtifactError(msg)
        self._artifacts[exact_type] = artifact
