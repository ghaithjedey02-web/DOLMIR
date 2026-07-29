# Risk Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4/§8.

**Owns:** The `RiskGate` — deterministic, mandatory, zero LLM involvement; position sizing; hard limits. `RiskGate.evaluate()` is the *only* code path that can produce an `ApprovedDecision` (illegal states unrepresentable, Standing Rule 5).

**Explicitly does not own:** Being an LLM debate participant with special powers. The Risk Manager *Agent* is a normal debate voice living in Orchestration; the Gate is not an agent at all.

**Depends on (engines):** Journal (read — realized risk statistics). Enforced by import-linter.

**Standing rules that bite here:** Rule 4 (the Gate's arithmetic is plain code, exhaustively unit-testable), Rule 8 (DOLMIR proposes, never executes).
