"""Orchestration — the scheduler, NOT a bounded context (CA §4).

Runs Agents as processes through the Reasoning Graph; owns the small
Hypothesis/AgentOpinion/ReasoningTrace domain and the ContextAssembler.
Nothing depends on orchestration except delivery (enforced by
import-linter). Implementation begins in Phase 2 (Docs/ROADMAP.md).
"""

__all__: list[str] = []
