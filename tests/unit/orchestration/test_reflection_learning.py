import pytest

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.reflection import (
    LearningSignal,
    LearningSignalKind,
    Reflection,
)
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind


def test_reflection_must_lock_in_the_falsification_condition() -> None:
    with pytest.raises(ValueError, match="lock-in is the point"):
        Reflection(
            trace_id=EntityId.generate(),
            falsification_restatement="   ",
            implications="watch the next reading",
        )


def test_reflection_must_state_implications() -> None:
    with pytest.raises(ValueError, match="implications"):
        Reflection(
            trace_id=EntityId.generate(),
            falsification_restatement="no 2x harmonic after replacement",
            implications=" ",
        )


def test_reflection_carries_open_uncertainties() -> None:
    reflection = Reflection(
        trace_id=EntityId.generate(),
        falsification_restatement="no 2x harmonic after replacement",
        implications="if the harmonic persists, the diagnosis was wrong",
        open_uncertainties=(
            Uncertainty(
                kind=UncertaintyKind.EPISTEMIC,
                description="alignment unmeasured",
                resolution="laser check on Friday",
            ),
        ),
    )
    assert Reflection.schema_version == 1
    assert len(reflection.open_uncertainties) == 1


def test_learning_signal_requires_a_statement() -> None:
    with pytest.raises(ValueError, match="statement"):
        LearningSignal(
            trace_id=EntityId.generate(),
            kind=LearningSignalKind.PROCESS_QUALITY,
            statement=" ",
        )


def test_learning_signal_carries_evidence() -> None:
    signal = LearningSignal(
        trace_id=EntityId.generate(),
        kind=LearningSignalKind.CALIBRATION,
        statement="HIGH-confidence conclusions in this setup resolved correctly 4 of 9 times",
        evidence=(
            Evidence(
                kind=EvidenceKind.COMPUTATION,
                source_ref="calibration_report",
                content="9 samples, 44% hit rate at HIGH",
            ),
        ),
    )
    assert LearningSignal.schema_version == 1
    assert signal.kind is LearningSignalKind.CALIBRATION
