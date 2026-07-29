"""Rebuilding a ``ReasoningTrace`` from its stored JSON document.

The serialization contract (``serialization.to_document``) deliberately left
deserialization to "the first persistence adapter that writes records to
disk" — that adapter arrives now (Phase 2B's SQLite store), so this is where
the inverse lives. It is explicit rather than reflective: one builder per
type, each failing loudly on a shape it does not recognize, because a
silently-lossy reader would corrupt years of trace history exactly like a
silently-lossy writer would (Core Architecture §16).

``schema_version`` is carried in every document; when a future record's shape
changes, this is where an upcaster keyed on that version will hang.
"""

from __future__ import annotations

from datetime import datetime

from dolmir.kernel.shared_kernel import EntityId
from dolmir.orchestration.failure import FailureKind, NodeFailure
from dolmir.orchestration.trace.challenge import Challenge, ChallengeSeverity
from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.confidence import Confidence, ConfidenceAssessment
from dolmir.orchestration.trace.epistemic import Evidence, EvidenceKind
from dolmir.orchestration.trace.hypothesis import Hypothesis
from dolmir.orchestration.trace.record import ReasoningTrace, RunStatus, StepStatus, TraceStep
from dolmir.orchestration.trace.serialization import JsonValue
from dolmir.orchestration.trace.uncertainty import Uncertainty, UncertaintyKind

__all__ = ["TraceDocumentError", "trace_from_document"]


class TraceDocumentError(ValueError):
    """A stored trace document is malformed or references an unknown shape."""


def trace_from_document(document: JsonValue) -> ReasoningTrace:
    """Reconstruct a ``ReasoningTrace`` from its ``to_document`` form."""
    node = _obj(document)
    conclusion_doc = node.get("conclusion")
    return ReasoningTrace(
        trace_id=_entity_id(node, "trace_id"),
        started_at=_datetime(node, "started_at"),
        completed_at=_datetime(node, "completed_at"),
        status=RunStatus(_str(node, "status")),
        seeded=tuple(_str_list(node.get("seeded"))),
        steps=tuple(_step(item) for item in _list(node.get("steps"))),
        conclusion=None if conclusion_doc is None else _conclusion(conclusion_doc),
    )


def _step(document: JsonValue) -> TraceStep:
    node = _obj(document)
    failure_doc = node.get("failure")
    skip_reason = node.get("skip_reason")
    return TraceStep(
        node_name=_str(node, "node_name"),
        status=StepStatus(_str(node, "status")),
        started_at=_datetime(node, "started_at"),
        completed_at=_datetime(node, "completed_at"),
        produced=tuple(_str_list(node.get("produced"))),
        summary=_optional_str(node.get("summary")) or "",
        failure=None if failure_doc is None else _failure(failure_doc),
        skip_reason=_optional_str(skip_reason),
    )


def _failure(document: JsonValue) -> NodeFailure:
    node = _obj(document)
    return NodeFailure(
        node_name=_str(node, "node_name"),
        kind=FailureKind(_str(node, "kind")),
        message=_str(node, "message"),
    )


def _conclusion(document: JsonValue) -> Conclusion:
    node = _obj(document)
    return Conclusion(
        chosen=_hypothesis(node.get("chosen")),
        confidence=_confidence(node.get("confidence")),
        rationale=_str(node, "rationale"),
        standing_challenges=tuple(
            _challenge(item) for item in _list(node.get("standing_challenges"))
        ),
        open_uncertainties=tuple(
            _uncertainty(item) for item in _list(node.get("open_uncertainties"))
        ),
    )


def _hypothesis(document: JsonValue) -> Hypothesis:
    node = _obj(document)
    return Hypothesis(
        hypothesis_id=_entity_id(node, "hypothesis_id"),
        statement=_str(node, "statement"),
        falsification_condition=_str(node, "falsification_condition"),
        represents_inaction=_bool(node.get("represents_inaction")),
    )


def _confidence(document: JsonValue) -> ConfidenceAssessment:
    node = _obj(document)
    return ConfidenceAssessment(
        hypothesis_id=_entity_id(node, "hypothesis_id"),
        level=Confidence(_int(node, "level")),
        basis=_str(node, "basis"),
    )


def _challenge(document: JsonValue) -> Challenge:
    node = _obj(document)
    return Challenge(
        hypothesis_id=_entity_id(node, "hypothesis_id"),
        objection=_str(node, "objection"),
        severity=ChallengeSeverity(_str(node, "severity")),
        evidence=tuple(_evidence(item) for item in _list(node.get("evidence"))),
    )


def _uncertainty(document: JsonValue) -> Uncertainty:
    node = _obj(document)
    return Uncertainty(
        kind=UncertaintyKind(_str(node, "kind")),
        description=_str(node, "description"),
        resolution=_optional_str(node.get("resolution")),
    )


def _evidence(document: JsonValue) -> Evidence:
    node = _obj(document)
    return Evidence(
        kind=EvidenceKind(_str(node, "kind")),
        source_ref=_str(node, "source_ref"),
        content=_str(node, "content"),
    )


# --------------------------------------------------------------------------- #
# Typed extractors — each raises TraceDocumentError on a shape mismatch.
# --------------------------------------------------------------------------- #


def _obj(value: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        msg = f"expected a JSON object, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _list(value: JsonValue) -> list[JsonValue]:
    if value is None:
        return []
    if not isinstance(value, list):
        msg = f"expected a JSON array, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _str(node: dict[str, JsonValue], key: str) -> str:
    value = node.get(key)
    if not isinstance(value, str):
        msg = f"field {key!r} must be a string, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _optional_str(value: JsonValue) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        msg = f"expected a string or null, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _int(node: dict[str, JsonValue], key: str) -> int:
    value = node.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        msg = f"field {key!r} must be an integer, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _bool(value: JsonValue) -> bool:
    if not isinstance(value, bool):
        msg = f"expected a boolean, got {type(value).__name__}"
        raise TraceDocumentError(msg)
    return value


def _str_list(value: JsonValue) -> list[str]:
    return [item for item in _list(value) if isinstance(item, str)]


def _entity_id(node: dict[str, JsonValue], key: str) -> EntityId:
    return EntityId.from_string(_str(node, key))


def _datetime(node: dict[str, JsonValue], key: str) -> datetime:
    return datetime.fromisoformat(_str(node, key))
