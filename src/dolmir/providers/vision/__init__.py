"""ChartVisionExtractorPort: chart image → structured, low-inference reading.

Core Architecture §4: vision is a provider, not an engine — a sophisticated
adapter behind one port. The V1 adapter is an Anthropic multimodal call
(``providers.vision`` may import ``providers.llm``); a dedicated CV model is
a later swap behind the same interface.
"""

from dolmir.providers.vision.anthropic import AnthropicChartVisionExtractor
from dolmir.providers.vision.fake import ScriptedChartVisionExtractor
from dolmir.providers.vision.port import ChartVisionExtractorPort
from dolmir.providers.vision.reading import ChartImage, ChartReading, VisionError

__all__ = [
    "AnthropicChartVisionExtractor",
    "ChartImage",
    "ChartReading",
    "ChartVisionExtractorPort",
    "ScriptedChartVisionExtractor",
    "VisionError",
]
