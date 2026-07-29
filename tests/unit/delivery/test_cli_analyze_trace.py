"""CLI coverage for the ``analyze`` and ``trace show`` commands.

Live ``analyze`` needs a model, a key, and a network, so these tests cover
its guard rails (missing key, bad image) rather than a live run — the full
pipeline is exercised offline in the integration suite. ``trace show`` is
tested end to end against a seeded SQLite store.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from dolmir.delivery.cli.main import main
from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.hypothesis import Hypothesis
from dolmir.orchestration.trace.record import ReasoningTrace, RunStatus, StepStatus, TraceStep
from dolmir.orchestration.trace.sqlite_repository import SqliteReasoningTraceRepository

_MOMENT = datetime(2026, 7, 29, 13, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if key.startswith("DOLMIR_"):
            monkeypatch.delenv(key)


def _completed_trace() -> ReasoningTrace:
    chosen = Hypothesis(
        hypothesis_id=EntityId(uuid.UUID(int=1)),
        statement="stand aside — no clear edge",
        falsification_condition="a clean setup forms",
        represents_inaction=True,
    )
    conclusion = Conclusion(
        chosen=chosen,
        confidence=ConfidenceAssessment(
            hypothesis_id=chosen.hypothesis_id, level=Confidence.MODERATE, basis="no clean edge"
        ),
        rationale="neither direction confirmed; standing aside",
    )
    return ReasoningTrace(
        trace_id=EntityId(uuid.UUID(int=42)),
        started_at=_MOMENT,
        completed_at=_MOMENT,
        status=RunStatus.COMPLETED,
        seeded=("ChartImage",),
        steps=(
            TraceStep(
                node_name="chief_decision",
                status=StepStatus.COMPLETED,
                started_at=_MOMENT,
                completed_at=_MOMENT,
                produced=("Conclusion",),
                summary="chief: chose to inaction",
            ),
        ),
        conclusion=conclusion,
    )


def test_analyze_without_api_key_fails_as_config_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    image = tmp_path / "chart.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n fake bytes")

    exit_code = main(["analyze", "--image", str(image), "--env-file", "/nonexistent/.env"])

    assert exit_code == 2
    assert "API key" in capsys.readouterr().err


def test_analyze_rejects_an_unsupported_image_type(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    not_an_image = tmp_path / "notes.txt"
    not_an_image.write_text("not a chart")

    exit_code = main(["analyze", "--image", str(not_an_image), "--env-file", "/nonexistent/.env"])

    assert exit_code == 1
    assert "unsupported image type" in capsys.readouterr().err


def test_analyze_reports_a_missing_image(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(
        ["analyze", "--image", "/no/such/chart.png", "--env-file", "/nonexistent/.env"]
    )

    assert exit_code == 1
    assert "no such image file" in capsys.readouterr().err


def test_trace_show_rejects_an_invalid_id(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["trace", "show", "--id", "not-a-uuid", "--env-file", "/nonexistent/.env"])

    assert exit_code == 1
    assert "not a valid trace id" in capsys.readouterr().err


def test_trace_show_reports_an_unknown_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("DOLMIR_PERSISTENCE__TRACE_DB_PATH", str(tmp_path / "traces.sqlite3"))
    unknown = str(EntityId(uuid.UUID(int=777)))

    exit_code = main(["trace", "show", "--id", unknown, "--env-file", "/nonexistent/.env"])

    assert exit_code == 1
    assert "no trace found" in capsys.readouterr().err


def test_trace_show_renders_a_persisted_trace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "traces.sqlite3"
    trace = _completed_trace()
    repository = SqliteReasoningTraceRepository.open(db)
    asyncio.run(repository.save(trace))
    repository.close()

    monkeypatch.setenv("DOLMIR_PERSISTENCE__TRACE_DB_PATH", str(db))
    exit_code = main(
        ["trace", "show", "--id", str(trace.trace_id), "--env-file", "/nonexistent/.env"]
    )

    out = capsys.readouterr().out
    assert exit_code == 0
    assert str(trace.trace_id) in out
    assert "CONCLUSION" in out
    assert "stand aside" in out
    assert "chief_decision" in out
