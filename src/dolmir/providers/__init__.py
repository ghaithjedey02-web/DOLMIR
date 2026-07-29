"""Cross-engine infrastructure adapters (CA §4 placement rule).

A capability consumed by multiple engines or by orchestration lives here
(LLM, vision, embeddings); a single-engine capability lives inside that
engine's own adapters. Providers import kernel only (enforced).
"""

__all__: list[str] = []
