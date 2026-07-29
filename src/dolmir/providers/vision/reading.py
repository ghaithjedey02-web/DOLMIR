"""Vision DTOs: a chart image in, a low-inference transcription out.

Cognitive Architecture §3 stage 1 (Perception) is deliberately dumb: it
transcribes what is on the chart — levels, structure, the last candles,
any visible symbol/timeframe — without interpreting it ("this is a fair
value gap" is Understanding's job, stage 2). Keeping perception uninterpreted
is what lets every downstream claim trace back to a faithful reading rather
than to the model's imagination (Cognitive Constitution §2/§8).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

__all__ = ["ChartImage", "ChartReading", "VisionError"]


@dataclass(frozen=True, kw_only=True, slots=True)
class ChartImage:
    """A chart image to analyze, carried inline so a run is self-contained.

    ``source_ref`` names the image for the audit trail (a filename, a URL a
    human pasted, an upload id); ``data_base64`` is the raw bytes, so the
    same request replays deterministically from a cassette.
    """

    source_ref: str
    media_type: str
    data_base64: str

    def __post_init__(self) -> None:
        """Reject untraceable or empty images."""
        if not self.source_ref.strip():
            msg = "ChartImage.source_ref must be non-empty"
            raise ValueError(msg)
        if not self.data_base64.strip():
            msg = "ChartImage.data_base64 must be non-empty"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class ChartReading:
    """A structured, low-inference transcription of one chart.

    ``features`` are plain transcribed observations (one per detected level,
    candle cluster, or structural mark) — the raw material the perception
    node turns into ``Observation``s. ``symbol`` and ``timeframe`` are
    recorded only when legibly present on the chart; ``None`` means "not
    visible", never a guess.
    """

    schema_version: ClassVar[int] = 1

    source_ref: str
    features: tuple[str, ...]
    symbol: str | None = None
    timeframe: str | None = None

    def __post_init__(self) -> None:
        """Reject an empty transcription — perceiving nothing is a failure."""
        if not self.features:
            msg = "ChartReading.features must contain at least one observation"
            raise ValueError(msg)


@dataclass(frozen=True, kw_only=True, slots=True)
class VisionError:
    """A typed account of a failed chart extraction (failure is data)."""

    message: str

    def __post_init__(self) -> None:
        """Reject unexplained errors."""
        if not self.message.strip():
            msg = "VisionError.message must be non-empty"
            raise ValueError(msg)
