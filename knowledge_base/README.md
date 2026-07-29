# DOLMIR Knowledge Base

**Content, not code.** Everything in this tree is curated trading doctrine —
the externally-authored knowledge DOLMIR's agents retrieve and cite
(Core Architecture §12). Nothing here is derived from any individual
trader's experience; that lives in Memory Engine's stores with entirely
different provenance and trust (Engineering Constitution §6, Core
Architecture §11).

## Domains

| Folder | Contents |
|---|---|
| `ict_smc/` | ICT / Smart Money Concepts: market structure, liquidity, order blocks, FVGs, PD arrays, kill zones, time theory |
| `psychology/` | Trading psychology doctrine |
| `risk_management/` | Risk doctrine: sizing, drawdown, exposure rules |
| `playbooks/` | Named, reusable setups with entry/invalidation criteria |

New domains are new folders — never a schema change (EC §6).

## Document format

Versioned markdown with YAML front-matter. Ingestion (Phase 4,
`Docs/ROADMAP.md`) chunks, embeds, and indexes these files; agents retrieve
passages and cite them by `id` + version.

```markdown
---
id: ict.breaker-block            # stable, unique, dot-namespaced
title: Breaker Block
category: ict_smc                # matches the folder
tags: [order-flow, structure]
related: [ict.order-block, ict.mitigation-block]
source: "<author/course/book reference>"
version: 1                       # bump on meaningful content change
---

# Breaker Block

<the doctrine itself>
```

Rules:

- One concept per file; keep files focused so retrieval returns precise
  passages.
- `id` is permanent once assigned — traces reference it for years.
- Content is git-versioned; a `ReasoningTrace` can pin the exact knowledge
  snapshot behind a decision (CA §12).
- Editing doctrine must never require touching code (EC §6).

## Status

Awaiting content: the collected educational material (ICT/SMC, psychology,
risk management, playbooks) is imported in Phase 4. The structure and
format above are fixed now so that material can land without rework.
