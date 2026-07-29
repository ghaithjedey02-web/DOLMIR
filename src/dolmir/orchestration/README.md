# The Cognitive Kernel — concept-to-code map

This package is DOLMIR's universal reasoning framework (Roadmap Phase 2A +
Amendments 2–3). It is **domain-agnostic by construction**: nothing in it
knows what trading, medicine, or robotics is — domains arrive as seeded
artifact types and specialist node implementations. Constitutional rules
are constructor rules: the illegal states below are unconstructible, not
discouraged.

## Sprint 2 vocabulary → frozen Foundation names

The Reasoning Kernel is the frozen **typed graph** engine (Core
Architecture §8: "an explicit directed graph of typed nodes executed by a
graph executor — *not a hardcoded linear function*"). Sprint 2's requested
names map onto it one-for-one; the engine is **not** re-implemented under a
second, linear-pipeline vocabulary (that would fork the frozen
architecture):

| Sprint 2 name | Frozen kernel home |
|---|---|
| PipelineExecutor | `graph.GraphExecutor` |
| PipelineStage interface | `graph.GraphNode` (+ the `agents.*Node` stage bases) |
| StageResult | `graph.NodeReport` |
| StageFailure | `failure.NodeFailure` |
| PipelineTrace | `trace.ReasoningTrace` |
| CognitiveContext | `graph.GraphContext` (the live run state) |
| ConfidenceAccumulator | `trace.ConfidenceReport` + `trace.synthesize_confidence` (pure, Standing Rule 4 — not mutable accumulation) |
| **ReasoningSession** | `session.ReasoningSession` — the run entry point (new) |
| **CognitiveState** | `session.CognitiveState` — the immutable outcome snapshot (new) |
| Hypothesis / Decision / Reflection | `trace.Hypothesis` / `trace.Decision` / `trace.Reflection` |

## Every cognitive concept, and where it lives

| Concept | Code | Structural law |
|---|---|---|
| Observation | `trace.observation.Observation` / `ObservationSet` | traceable source, tz-aware time, non-empty |
| Interpretation | `trace.observation.Interpretation` | ≥1 claim, provenance to ≥1 observation |
| Evidence | `trace.epistemic.Evidence` | traceable `source_ref`, never empty |
| **Fact** | `trace.epistemic.Claim` with `EpistemicStatus.FACT` — *deliberately not a separate class* | unconstructible without citation/computation evidence (CC §2) |
| Assumption | `Claim` with `EpistemicStatus.ASSUMPTION` | labeled interpretation; never silently promoted (CC §8) |
| Context | `graph.GraphContext` | typed, write-once artifacts; executor-only writes |
| Hypothesis | `trace.hypothesis.Hypothesis` | pre-registered falsification condition required (CC §4) |
| **Counter-Hypothesis** | competing `HypothesisSet` members + `trace.challenge.Challenge` — *deliberately not a separate class* | the set is mutually exclusive; challenges attack specific members (CC §9) |
| Inaction option | `Hypothesis(represents_inaction=True)` | exactly one per `HypothesisSet` (CC §6) |
| Debate | several `agents.DeliberationNode`s in one wave | opinions accumulate; one lost voice degrades, never cancels |
| Critical analysis | `agents.FalsificationNode` → `FalsificationReport` | coverage of every hypothesis attested; deciding without it fails graph assembly |
| Confidence | `trace.confidence.Confidence` (+`ConfidenceAssessment`/`Report`) | ordered vocabulary, no fabricated decimals (CC §5); every level carries its basis |
| Confidence synthesis | `trace.synthesis.synthesize_confidence` | deterministic plain code (Standing Rule 4) |
| Uncertainty | `trace.uncertainty.Uncertainty` | aleatory forbids a resolution; epistemic requires one (CogA §5) |
| Risk | `trace.decision.IdentifiedRisk` / `RiskAssessment` | acceptable + unmitigated CRITICAL risk is contradictory |
| Decision | `trace.decision.Decision` (epistemic outcome = `Conclusion`) | action over unacceptable risk is unconstructible; inaction always permitted |
| Explanation | `trace.explanation.build_explanation` → `Explanation` | deterministic rendering of the trace — it invents nothing |
| Reflection | `trace.reflection.Reflection` | locks in the falsification restatement pre-outcome (CC §4) |
| Learning Signal | `trace.reflection.LearningSignal` | slow-loop shape; producing stages arrive Phase 8 |
| Belief | `trace.belief.Belief` | provenance required; revision is append-only via `supersedes` |
| World Model | `trace.belief.WorldModel` | immutable; `revised()` returns a new model, history reconstructable |
| Reasoning Trace | `trace.record.ReasoningTrace` | `schema_version` from the first record (Standing Rule 6); every step recorded, including failures and skips |
| Serialization | `trace.serialization.to_document` | every object → JSON; unknown types fail loudly |

## The fast-loop pipeline, stage by stage (CogA §3)

Every stage is a `GraphNode`; each has a reusable abstract base in
`agents.stages` whose subclass supplies the judgment. The executor derives
the ordering below from the artifact *types* the nodes declare — stages
never name each other.

```
 1 Perception          agents.PerceptionNode            → ObservationSet
 2 Understanding       agents.InterpretationNode        → Interpretation
 3 Context Building    agents.ContextBuildingNode       → AssembledContext
 4 World Model Update  agents.WorldModelUpdateNode      → WorldModel
 5 Hypothesis Gen.     agents.HypothesisGenerationNode  → HypothesisSet
 6 Internal Debate     N × agents.DeliberationNode      → AgentOpinion (accumulating)
 7 Critical Thinking   agents.FalsificationNode         → FalsificationReport
 8 Confidence Synth.   agents.ConfidenceSynthesisNode   → ConfidenceReport   (deterministic)
 9 Risk Evaluation     agents.RiskEvaluationNode        → RiskAssessment
10 Decision            agents.ChiefDecisionNode         → Conclusion
                       agents.DecisionNode              → Decision           (risk-gated)
11 Explanation         session.ReasoningSession         → Explanation        (from the finished trace)
12 Immediate Reflect.  agents.ReflectionNode            → Reflection
```

**Running it:** `session.ReasoningSession.run(graph, seeds=…)` executes the
assembled graph, persists the complete `ReasoningTrace`, renders the
`Explanation` from the finished trace (stage 11 — it needs the whole
trace, so it is a session step, not an in-graph node), and returns an
immutable `CognitiveState`.

**Slow Learning Loop:** placeholder only. The `LearningSignal` shape
exists; the stages that *produce* it require real outcomes and arrive in
Phase 8. There is intentionally no `LearningNode` yet.

The constitutional gate at assembly: any node producing `Conclusion` must
require `FalsificationReport` and `ConfidenceReport`, so a deciding graph
that skips self-critique cannot be assembled at all.

## Deliberate non-abstractions

Two requested concepts are mappings, not classes, to avoid abstraction for
its own sake: **Fact** (a grounding *rule* on `Claim`, which keeps the
fact/assumption boundary a validated property instead of a parallel class
hierarchy) and **Counter-Hypothesis** (the hypothesis set is already
mutually exclusive, and `Challenge` already carries targeted opposition —
a third representation would give the same idea three homes).

Likewise there is no `LearningNode` yet: learning requires outcomes, which
requires the Journal (Phase 3) and elapsed reality (Phase 8 ⏳). Shipping
the shape without the stage is honest; shipping a stage with nothing to
learn from would be theater.
