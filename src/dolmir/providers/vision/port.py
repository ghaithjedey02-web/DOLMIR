"""The chart-vision extraction port.

Core Architecture §4 demoted vision from an engine to a provider: it owns no
domain invariants, it is "chart image → structured observation", a
sophisticated adapter. The V1 adapter is an Anthropic multimodal call; a
dedicated computer-vision model could replace it behind this same port
(Phase 10) with nothing upstream changing.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from dolmir.kernel.shared_kernel import Result
from dolmir.providers.vision.reading import ChartImage, ChartReading, VisionError

__all__ = ["ChartVisionExtractorPort"]


@runtime_checkable
class ChartVisionExtractorPort(Protocol):
    """Transcribes a chart image into a structured, low-inference reading."""

    async def extract(self, image: ChartImage) -> Result[ChartReading, VisionError]:
        """Transcribe ``image``, returning the reading or a typed failure."""
        ...
