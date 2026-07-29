"""Perception: a chart image becomes faithful, uninterpreted observations.

Cognitive Architecture §3 stage 1. This node owns no judgment of its own —
it delegates to the ``ChartVisionExtractorPort`` and mechanically turns each
transcribed feature into an ``Observation`` with provenance back to the
source image. Interpretation ("that gap is a fair value gap") is the next
stage's job, never this one's.
"""

from __future__ import annotations

from datetime import datetime

from dolmir.kernel.shared_kernel import EntityId, Err, Ok, Result
from dolmir.orchestration.agents.stages import PerceptionNode
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.graph.context import GraphContext
from dolmir.orchestration.trace.observation import Observation, ObservationSet
from dolmir.providers.vision.port import ChartVisionExtractorPort
from dolmir.providers.vision.reading import ChartImage, ChartReading

__all__ = ["ChartPerceptionNode"]


class ChartPerceptionNode(PerceptionNode):
    """Transcribes the seeded ``ChartImage`` into an ``ObservationSet``."""

    def __init__(self, extractor: ChartVisionExtractorPort) -> None:
        """Inject the chart extractor; declare the seeded image as input."""
        super().__init__(extra_requires=frozenset({ChartImage}))
        self._extractor = extractor

    @property
    def name(self) -> str:
        """Node name."""
        return "perception"

    async def perceive(self, context: GraphContext) -> Result[ObservationSet, NodeFailure]:
        """Extract the chart and transcribe each feature into an observation."""
        image = context.get(ChartImage)
        match await self._extractor.extract(image):
            case Ok(reading):
                return Ok(self._to_observations(reading, observed_at=context.clock.now()))
            case Err(error):
                return Err(
                    NodeFailure(
                        node_name=self.name,
                        kind=FailureKind.EXTERNAL_ERROR,
                        message=f"chart perception failed: {error.message}",
                    )
                )

    def _to_observations(self, reading: ChartReading, *, observed_at: datetime) -> ObservationSet:
        """Build one observation per transcribed feature, plus a chart header."""
        members: list[Observation] = []

        header = _header(reading)
        if header is not None:
            members.append(
                Observation(
                    observation_id=EntityId.generate(),
                    source_ref=reading.source_ref,
                    content=header,
                    observed_at=observed_at,
                )
            )
        for index, feature in enumerate(reading.features):
            members.append(
                Observation(
                    observation_id=EntityId.generate(),
                    source_ref=f"{reading.source_ref}#feature-{index}",
                    content=feature,
                    observed_at=observed_at,
                )
            )
        return ObservationSet(members=tuple(members))


def _header(reading: ChartReading) -> str | None:
    """A one-line summary of visible symbol/timeframe, if either is present."""
    parts = [part for part in (reading.symbol, reading.timeframe) if part is not None]
    if not parts:
        return None
    return "chart context: " + " ".join(parts)
