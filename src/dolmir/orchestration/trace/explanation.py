"""The explainability pipeline: structured trace → legible account.

Cognitive Constitution §11: every cognitive output explains itself in
language the reader can actually read — not merely a persisted structure a
developer could query. Explanation is deterministic rendering of what the
run already recorded; it invents nothing, so it cannot hallucinate
(rendering is not reasoning).
"""

from __future__ import annotations

from dataclasses import dataclass

from dolmir.orchestration.trace.conclusion import Conclusion
from dolmir.orchestration.trace.epistemic import Evidence
from dolmir.orchestration.trace.opinion import AgentOpinion, Stance
from dolmir.orchestration.trace.record import ReasoningTrace, StepStatus

__all__ = ["Explanation", "build_explanation"]


@dataclass(frozen=True, kw_only=True, slots=True)
class Explanation:
    """A structured, renderable account of one reasoning run.

    Each section is plain prose assembled from the trace's typed objects;
    ``render_text`` joins them for terminal/report display. Delivery
    adapters may render the same sections into richer formats without
    re-deriving anything.
    """

    outcome: str
    reasoning: str
    evidence: tuple[str, ...]
    dissent: str
    falsification: str
    process: tuple[str, ...]

    def render_text(self) -> str:
        """Render the full explanation as plain text."""
        lines: list[str] = ["CONCLUSION", self.outcome, "", "WHY", self.reasoning]
        if self.evidence:
            lines += ["", "EVIDENCE CITED"]
            lines += [f"  - {item}" for item in self.evidence]
        lines += ["", "DISSENT & OPEN CHALLENGES", self.dissent]
        lines += ["", "THIS CONCLUSION IS WRONG IF", self.falsification]
        lines += ["", "PROCESS"]
        lines += [f"  {item}" for item in self.process]
        return "\n".join(lines)


def _evidence_line(item: Evidence) -> str:
    """One rendered evidence citation."""
    return f"[{item.kind.value}] {item.source_ref}: {item.content}"


def _dissent_section(conclusion: Conclusion, opinions: tuple[AgentOpinion, ...]) -> str:
    """Summarize opposition and unresolved challenges against the choice."""
    parts: list[str] = []
    for opinion in opinions:
        assessment = opinion.assessment_for(conclusion.chosen.hypothesis_id)
        if assessment is not None and assessment.stance is Stance.OPPOSES:
            parts.append(
                f"{opinion.role} opposed ({assessment.confidence.name}): {assessment.reasoning}"
            )
    for challenge in conclusion.standing_challenges:
        parts.append(f"unresolved {challenge.severity.value} challenge: {challenge.objection}")
    for uncertainty in conclusion.open_uncertainties:
        line = f"open {uncertainty.kind.value} uncertainty: {uncertainty.description}"
        if uncertainty.resolution is not None:
            line += f" (resolves when: {uncertainty.resolution})"
        parts.append(line)
    if not parts:
        return "None recorded — no opposing stance or standing challenge against the choice."
    return "\n".join(f"  - {part}" for part in parts)


def build_explanation(
    trace: ReasoningTrace,
    conclusion: Conclusion,
    opinions: tuple[AgentOpinion, ...],
) -> Explanation:
    """Assemble the explanation for a completed run.

    Everything rendered here already exists in typed form; this function
    only arranges it (CC §11). The falsification section restates the
    chosen hypothesis's pre-registered condition — the same one the slow
    loop will grade against later (CC §4).
    """
    chosen = conclusion.chosen
    outcome = (
        f"{'No action' if conclusion.is_inaction else 'Chosen'}: {chosen.statement} "
        f"(confidence: {conclusion.confidence.level.name})"
    )
    reasoning = f"{conclusion.rationale}\nConfidence basis: {conclusion.confidence.basis}"

    cited: list[str] = []
    seen: set[str] = set()
    for opinion in opinions:
        assessment = opinion.assessment_for(chosen.hypothesis_id)
        if assessment is None:
            continue
        for item in assessment.evidence:
            line = _evidence_line(item)
            if line not in seen:
                seen.add(line)
                cited.append(line)

    process: list[str] = []
    for step in trace.steps:
        if step.status is StepStatus.COMPLETED:
            detail = step.summary or ", ".join(step.produced)
        elif step.status is StepStatus.FAILED and step.failure is not None:
            detail = f"failed: {step.failure.message}"
        else:
            detail = f"skipped: {step.skip_reason}"
        process.append(f"{step.node_name}: {step.status.value} — {detail}")

    return Explanation(
        outcome=outcome,
        reasoning=reasoning,
        evidence=tuple(cited),
        dissent=_dissent_section(conclusion, opinions),
        falsification=chosen.falsification_condition,
        process=tuple(process),
    )
