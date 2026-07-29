"""A scripted chart extractor for pipeline tests.

Returns a preset ``ChartReading`` (or a preset failure) keyed by the image's
``source_ref``, so an end-to-end ``analyze`` run is driven with no model and
no network — the same offline discipline as the scripted LLM provider.
"""

from __future__ import annotations

from collections.abc import Mapping

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.providers.vision.reading import ChartImage, ChartReading, VisionError

__all__ = ["ScriptedChartVisionExtractor"]


class ScriptedChartVisionExtractor:
    """A ``ChartVisionExtractorPort`` that answers from a fixed script."""

    def __init__(
        self,
        readings: Mapping[str, ChartReading | VisionError],
    ) -> None:
        """Map each image ``source_ref`` to the reading (or error) to return."""
        self._readings = dict(readings)

    async def extract(self, image: ChartImage) -> Result[ChartReading, VisionError]:
        """Return the scripted outcome for ``image.source_ref``."""
        outcome = self._readings.get(image.source_ref)
        if outcome is None:
            return Err(VisionError(message=f"no scripted chart reading for {image.source_ref!r}"))
        if isinstance(outcome, VisionError):
            return Err(outcome)
        return Ok(outcome)
