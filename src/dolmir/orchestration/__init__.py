"""Orchestration — the scheduler and the Cognitive Reasoning Engine.

NOT a bounded context (CA §4): this package owns the generic reasoning
substrate every specialist runs on — the typed graph executor, the
structured reasoning objects, the stage toolkit, and the explainability
pipeline. It contains zero domain knowledge: nothing here knows what
trading, medicine, or law is; domains arrive as seeded artifacts and
specialist node implementations (Phase 2B onward).

Sub-packages:

- ``graph``   — execution engine: GraphNode, GraphContext, ReasoningGraph,
  GraphExecutor, failure-as-data.
- ``trace``   — structured reasoning objects: Evidence/Claim (epistemic
  tags), Hypothesis (pre-registered falsification), AgentOpinion,
  Challenge, Confidence, Conclusion, ReasoningTrace + repository port,
  Explanation.
- ``agents``  — stage-node toolkit + ChiefDecisionPort with the
  deterministic reference synthesizer.
- ``context`` — reserved for the ContextAssembler (Phase 5).
"""

__all__: list[str] = []
