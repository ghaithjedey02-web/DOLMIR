"""The Anthropic multimodal chart extractor.

It hands the chart image plus a tight, transcription-only instruction to a
vision-capable ``LLMProviderPort`` and parses the model's prompted JSON into
a ``ChartReading``. The instruction repeatedly forbids interpretation because
this is stage 1 (Perception): the model that later argues about fair-value
gaps must first agree on what pixels are actually there (CogA §3).
"""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok, Result
from dolmir.providers.llm.messages import (
    ImageBlock,
    LLMMessage,
    LLMRequest,
    Role,
    TextBlock,
)
from dolmir.providers.llm.port import LLMProviderPort
from dolmir.providers.llm.structured import extract_json_object
from dolmir.providers.llm.transport import JsonValue
from dolmir.providers.vision.reading import ChartImage, ChartReading, VisionError

__all__ = ["AnthropicChartVisionExtractor"]

_SYSTEM_PROMPT = (
    "You are a chart transcriber, not an analyst. Report only what is "
    "visibly present on the chart. Do NOT predict, do NOT recommend, do NOT "
    "label patterns with trading names (no 'fair value gap', no 'liquidity "
    "sweep'). Transcribe faithfully."
)

_INSTRUCTION = (
    "Transcribe this trading chart as JSON with exactly these keys:\n"
    '  "symbol": the ticker/instrument if legibly printed, else null\n'
    '  "timeframe": the timeframe if legibly printed (e.g. "15m", "4H"), else null\n'
    '  "features": an array of short, factual observations — visible price '
    "levels and how often they were touched, the shape/direction of recent "
    "candles, obvious swing highs/lows, gaps, and any printed values. Each "
    "item is one plain observation with no interpretation.\n"
    "Return only the JSON object."
)


class AnthropicChartVisionExtractor:
    """A ``ChartVisionExtractorPort`` backed by a vision-capable LLM provider."""

    def __init__(self, *, provider: LLMProviderPort, max_tokens: int = 1024) -> None:
        """Inject the multimodal provider used to read charts."""
        self._provider = provider
        self._max_tokens = max_tokens

    async def extract(self, image: ChartImage) -> Result[ChartReading, VisionError]:
        """Transcribe ``image`` into a structured reading."""
        if not self._provider.supports_vision():
            return Err(
                VisionError(
                    message=(
                        f"provider {self._provider.model_id!r} is not configured "
                        "for vision; a chart cannot be perceived"
                    )
                )
            )

        request = LLMRequest(
            model=self._provider.model_id,
            system=_SYSTEM_PROMPT,
            messages=(
                LLMMessage(
                    role=Role.USER,
                    content=(
                        ImageBlock(media_type=image.media_type, data_base64=image.data_base64),
                        TextBlock(_INSTRUCTION),
                    ),
                ),
            ),
            max_tokens=self._max_tokens,
        )

        match await self._provider.complete(request):
            case Ok(response):
                return self._parse(response.text, source_ref=image.source_ref)
            case Err(error):
                return Err(VisionError(message=f"vision provider failed: {error.message}"))

    @staticmethod
    def _parse(text: str, *, source_ref: str) -> Result[ChartReading, VisionError]:
        """Parse the model's prompted JSON into a ``ChartReading``."""
        document = extract_json_object(text)
        if document is None:
            return Err(VisionError(message="chart extraction returned no parseable JSON object"))

        features = _string_list(document.get("features"))
        if not features:
            return Err(
                VisionError(message="chart extraction produced no usable feature observations")
            )

        return Ok(
            ChartReading(
                source_ref=source_ref,
                features=tuple(features),
                symbol=_optional_string(document.get("symbol")),
                timeframe=_optional_string(document.get("timeframe")),
            )
        )


def _string_list(value: JsonValue) -> list[str]:
    """Coerce a JSON value into a list of non-empty strings (dropping the rest)."""
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _optional_string(value: JsonValue) -> str | None:
    """A trimmed non-empty string, or ``None`` for anything else."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
