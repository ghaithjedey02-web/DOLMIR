# ADR-0007 — Epistemic status tagging and NON_DETERMINATO as a first-class result

**Status:** Proposed · **Date:** 2026-09-02

## Context

Directive §2, §10, §11: DOLMIR does not guess. When evidence is insufficient or contradictory it must produce `NON DETERMINATO` with what is known, unknown, which evidence exists and conflicts, what input is missing, and which human decision is required. Confidence percentages must not be fabricated without calibration data. Every important conclusion must be traceable to evidence.

The historical Trader OS branch already proved a structural version of this (a `FACT` claim unconstructible without citation or computation; uncertainty typed as aleatory vs epistemic; an ordered confidence vocabulary). The current website console already exposes `declare_not_determined` and `request_human_decision` as the model's only ways to say so.

## Decision

1. The kernel defines `EpistemicStatus = FACT | OBSERVATION | ASSUMPTION | HYPOTHESIS`. A `Claim` carries a status and `Evidence` items; constructing a `FACT` without at least one `COMPUTATION` or `CITATION` evidence, or an `OBSERVATION` without `OBSERVATION` evidence, is a programming error caught at construction.
2. `Evidence` always names a traceable `sourceRef` (document id + span, computation name + inputs, record id + field). Untraceable evidence is not evidence.
3. Uncertainty is typed: `MISSING_INFORMATION` (reducible; must name what would resolve it) vs `STOCHASTIC` (irreducible; cannot carry a resolution).
4. **`NonDeterminato`** is a first-class result type alongside successful outcomes — never an exception, never an empty result. It carries: `known` (claims), `unknown` (named gaps), `evidence`, `conflicts` (pairs of contradicting evidence), `missingInputs`, `requiredHumanDecision`.
5. Model-reported per-field confidence (0–1) is treated as an **ordering signal for review routing** against configured floors, and is stored as such; it is never displayed as a calibrated probability until a calibration record exists. Thresholds are configuration, versioned.
6. The built-in tools `declare_non_determinato` and `request_human_decision` exist in the platform from Phase 0 so every future workflow inherits them.

## Why

Converting uncertainty into fabricated certainty is the failure mode the product exists to prevent. Making the honest outcome a normal, typed, routable result (not an error path) is what keeps it reachable in every workflow.

## Alternatives considered

- Free-text "I'm not sure" in model output — unparseable, unauditable, unroutable.
- Numeric confidence everywhere — precision without calibration is misleading (Directive §10).
- Throwing an error on insufficiency — collapses a legitimate business outcome into a failure path and loses the structured "what is missing".

## Consequences

- Every pipeline stage that can fail on evidence returns `Result<T | NonDeterminato, DomainError>` and the UI can always answer "why".
- A calibration record (predicted vs realised) becomes possible later because confidence signals and outcomes are stored separately.
