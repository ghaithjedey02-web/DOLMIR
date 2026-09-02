# ADR-0002 — Runtime and stack: TypeScript core, Python reserved for bounded workers

**Status:** Proposed (implementation proceeds on this decision; product owner may veto before merge) · **Date:** 2026-09-02

## Context

The Master Build Directive (§5) asks for an explicit evaluation of the runtime boundary rather than an assumption: TypeScript where it fits, Python where it brings a real technical advantage, no second runtime without a concrete reason.

Evidence gathered during discovery:

- The current commercial code (`ghaithjedey02-web/prova_1`: AI layer, RFQ engine, workflow definitions, the dolmir.com site) is TypeScript on Node.
- The website is a Next.js application deployed on Vercel; a future PWA/mobile delivery will be TypeScript regardless of the backend.
- The managed data platform named by the directive (Supabase) and the hosting (Vercel) have first-class TypeScript tooling.
- The only Python code in this repository is the historical Trader OS branch, which the directive explicitly excludes from the current product.
- The Phase 0 and first-slice AI responsibilities are LLM orchestration with structured outputs, deterministic verification, and native text extraction from emails and PDFs — all well served by TypeScript (Zod schemas as typed tool contracts, the official Anthropic SDK with structured outputs, mature PDF/e-mail parsing libraries).
- Python's decisive advantages are concentrated in heavy document processing (OCR, layout analysis, table reconstruction) and evaluation/data-science work — neither is a Phase 0 responsibility, and modern multimodal models reduce the OCR need for the first slice.

## Decision

1. The DOLMIR platform is a **TypeScript / Node.js 22 LTS** modular monolith managed with **pnpm workspaces**, strict TypeScript, ESLint (type-aware) and Prettier, Vitest for tests.
2. **Python is permitted, not banned**, for future *bounded, stateless worker services* behind ports (`DocumentTextExtractorPort`, evaluation tooling) when one of these triggers is met: native text extraction is insufficient for a paying client's documents and a Python library materially outperforms the TypeScript options; evaluation datasets need statistical tooling beyond simple scoring; a data-processing job cannot meet its latency or cost target in Node.
3. A Python worker never accesses the database directly; it exchanges typed payloads with the core over an explicit contract, so the LLM boundary and tenant isolation remain enforced in one place.

## Why

One language end to end (API, future PWA, shared Zod contracts) with the smallest operational footprint; the existing product code is already TypeScript; the runtime boundary is defined in advance so adding Python later is an addition, not a redesign.

## Alternatives considered

- **Python core (FastAPI + SQLAlchemy/asyncpg + pydantic):** strong for AI/data; would create a Python backend + TypeScript frontend split from day one, discard the existing TypeScript product code, and leave Supabase/Vercel tooling second-class. Rejected for this product; the Trader OS constitution's Python recommendation was made for a quant-adjacent domain that is not this product.
- **Both runtimes from day one:** doubles build, dependency, CI and security surface before any responsibility requires it. Rejected (Directive §5: "Do not create two runtimes unnecessarily").
- **Deno/Bun as runtime:** less mature production and driver ecosystem for a long-lived platform. Rejected.

## Consequences

- The platform's AI layer supersedes `prova_1/packages/ai-core` as the canonical implementation; useful parts are ported, not imported across repositories.
- Contributors need Node 22 and pnpm; developer documentation reflects this.
- The Python triggers above are reviewed when the first vertical slice meets real client documents; adopting a Python worker requires a new ADR.
