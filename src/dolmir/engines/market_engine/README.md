# Market Engine

Bounded context. Boundaries per `Docs/architecture/DOLMIR_FOUNDATION.md`, Core Architecture §4.

**Owns:** Market structure, liquidity, order blocks, fair value gaps, sessions/kill zones, macro & news calendar, higher-timeframe context. From Phase 10: the `InstrumentWorldModel` (persistent, recency-weighted market state).

**Explicitly does not own:** Deciding trades (Orchestration/Chief Decision), sizing risk (Risk Engine), raw chart-pixel parsing (delegated to `providers/vision` behind `ChartVisionExtractorPort`).

**Depends on (engines):** none — this is a leaf of the engine graph (enforced by import-linter).

**Standing rules that bite here:** deterministic detection math is plain code, never LLM token prediction (Standing Rule 4); all time arrives through `ClockPort` (Standing Rule 7) so backtesting works.
