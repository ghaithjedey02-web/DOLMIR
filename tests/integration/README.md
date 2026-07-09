# Integration tests

Adapter tests against real or sandboxed externals (Core Architecture §18):
LLM calls are cassette-recorded for cost and determinism, with a small
periodic live-API smoke suite to catch real drift; database adapters run
against real (local) engines.

First entries arrive with the first real adapters in Phase 2
(`Docs/ROADMAP.md`). Unit tests (`tests/unit/`) never do I/O; everything
that does belongs here.
