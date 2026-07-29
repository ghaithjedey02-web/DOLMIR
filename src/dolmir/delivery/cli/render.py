"""Terminal rendering for the analyze and trace-show commands.

Rendering is presentation only — it invents nothing the reasoning did not
already produce (Cognitive Constitution §11). The live ``analyze`` view uses
the run's rendered ``Explanation``; ``trace show`` renders the persisted
trace directly (its steps and conclusion), since a stored trace is the audit
record and does not carry the ephemeral debate opinions.
"""

from __future__ import annotations

from dolmir.orchestration.session.state import CognitiveState
from dolmir.orchestration.trace.record import ReasoningTrace, StepStatus, TraceStep
from dolmir.providers.llm import UsageLedger

__all__ = ["render_analysis", "render_trace"]


def render_analysis(state: CognitiveState, ledger: UsageLedger) -> str:
    """Render a completed analysis: explanation, decision, cost, trace id."""
    lines: list[str] = []
    if state.explanation is not None:
        lines.append(state.explanation.render_text())
    else:
        lines.append("Run aborted before a conclusion was reached; see the trace.")

    lines.append("")
    lines.append("DECISION")
    if state.decision is not None:
        lines.append(f"  {state.decision.action}")
    else:
        lines.append("  (no decision — run aborted)")

    lines.append("")
    lines.append("COST")
    lines.append(f"  {ledger.summary()}")

    lines.append("")
    lines.append(f"TRACE ID  {state.trace_id}")
    lines.append("  Inspect it later with:  dolmir trace show --id " + str(state.trace_id))
    return "\n".join(lines)


def render_trace(trace: ReasoningTrace) -> str:
    """Render a persisted trace's process log and conclusion."""
    lines = [
        f"TRACE {trace.trace_id}",
        f"  status:  {trace.status.value}",
        f"  seeded:  {', '.join(trace.seeded) or '(none)'}",
        f"  from {trace.started_at.isoformat()} to {trace.completed_at.isoformat()}",
        "",
        "PROCESS",
    ]
    for step in trace.steps:
        lines.append(f"  {step.node_name}: {step.status.value} — {_step_detail(step)}")

    lines.append("")
    lines.append("CONCLUSION")
    if trace.conclusion is None:
        lines.append("  (none — the run aborted before concluding)")
        return "\n".join(lines)

    conclusion = trace.conclusion
    verb = "No action" if conclusion.is_inaction else "Chosen"
    lines.append(f"  {verb}: {conclusion.chosen.statement}")
    lines.append(
        f"  confidence: {conclusion.confidence.level.name} — {conclusion.confidence.basis}"
    )
    lines.append(f"  rationale: {conclusion.rationale}")
    lines.append(f"  wrong if: {conclusion.chosen.falsification_condition}")
    for challenge in conclusion.standing_challenges:
        lines.append(f"  standing {challenge.severity.value} challenge: {challenge.objection}")
    for uncertainty in conclusion.open_uncertainties:
        detail = uncertainty.description
        if uncertainty.resolution is not None:
            detail += f" (resolves when: {uncertainty.resolution})"
        lines.append(f"  open {uncertainty.kind.value} uncertainty: {detail}")
    return "\n".join(lines)


def _step_detail(step: TraceStep) -> str:
    """The one-line detail for a trace step, by its terminal status."""
    if step.status is StepStatus.COMPLETED:
        return step.summary or ", ".join(step.produced) or "completed"
    if step.status is StepStatus.FAILED and step.failure is not None:
        return f"{step.failure.kind.value}: {step.failure.message}"
    return step.skip_reason or "skipped"
