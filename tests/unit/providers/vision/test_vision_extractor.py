"""The Anthropic chart extractor and the scripted vision fake."""

from __future__ import annotations

from dolmir.kernel.shared_kernel import Err, Ok
from dolmir.providers.llm import ScriptedLLMProvider, ScriptedReply
from dolmir.providers.llm.structured import extract_json_object
from dolmir.providers.vision import (
    AnthropicChartVisionExtractor,
    ChartImage,
    ChartReading,
    ScriptedChartVisionExtractor,
    VisionError,
)

_IMAGE = ChartImage(source_ref="eurusd-15m.png", media_type="image/png", data_base64="ZmFrZQ==")

_GOOD_JSON = (
    "Here is the transcription:\n"
    "```json\n"
    '{"symbol": "EURUSD", "timeframe": "15m", "features": '
    '["horizontal level at 1.0850 touched 3 times", "bullish engulfing at right edge"]}\n'
    "```\n"
)


async def test_extractor_parses_prompted_json() -> None:
    provider = ScriptedLLMProvider([ScriptedReply(match="transcribe", text=_GOOD_JSON)])
    extractor = AnthropicChartVisionExtractor(provider=provider)

    result = await extractor.extract(_IMAGE)

    assert isinstance(result, Ok)
    reading = result.value
    assert reading.symbol == "EURUSD"
    assert reading.timeframe == "15m"
    assert reading.features[0].startswith("horizontal level")
    assert reading.source_ref == "eurusd-15m.png"


async def test_extractor_refuses_a_non_vision_provider() -> None:
    provider = ScriptedLLMProvider([ScriptedReply(match="x", text="{}")], supports_vision=False)
    extractor = AnthropicChartVisionExtractor(provider=provider)

    result = await extractor.extract(_IMAGE)

    assert isinstance(result, Err)
    assert "not configured for vision" in result.error.message


async def test_extractor_reports_unparseable_output() -> None:
    provider = ScriptedLLMProvider([ScriptedReply(match="transcribe", text="no json here")])
    extractor = AnthropicChartVisionExtractor(provider=provider)

    result = await extractor.extract(_IMAGE)

    assert isinstance(result, Err)
    assert "no parseable JSON" in result.error.message


async def test_extractor_reports_empty_features() -> None:
    provider = ScriptedLLMProvider(
        [ScriptedReply(match="transcribe", text='{"symbol": "X", "features": []}')]
    )
    extractor = AnthropicChartVisionExtractor(provider=provider)

    result = await extractor.extract(_IMAGE)

    assert isinstance(result, Err)
    assert "no usable feature" in result.error.message


async def test_scripted_extractor_returns_preset_reading() -> None:
    reading = ChartReading(source_ref="eurusd-15m.png", features=("a level",))
    extractor = ScriptedChartVisionExtractor({"eurusd-15m.png": reading})

    result = await extractor.extract(_IMAGE)

    assert isinstance(result, Ok)
    assert result.value is reading


async def test_scripted_extractor_returns_preset_error() -> None:
    extractor = ScriptedChartVisionExtractor(
        {"eurusd-15m.png": VisionError(message="blurry chart")}
    )
    result = await extractor.extract(_IMAGE)
    assert isinstance(result, Err)
    assert result.error.message == "blurry chart"


def test_extract_json_object_handles_fences_and_trailing_prose() -> None:
    assert extract_json_object('```json\n{"a": 1}\n``` thanks!') == {"a": 1}
    assert extract_json_object('{"nested": {"b": [1, 2]}} trailing') == {"nested": {"b": [1, 2]}}
    assert extract_json_object("a string with { but no close") is None
    assert extract_json_object("no object at all") is None
    # A brace inside a string must not end the object early.
    assert extract_json_object('{"note": "a } brace"}') == {"note": "a } brace"}
