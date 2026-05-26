---
title: Karpathy three-layer LLM wiki
description: >-
  Brain layout — immutable raw → 15-40-line theme pages → category indexes. Many
  small pages > few large summaries.
category: pattern
keywords:
  - karpathy
  - llm-wiki
  - three-layer
  - theme-pages
  - raw
  - indexes
  - obsidian
created_at: 2026-05-04T17:55:00.000Z
updated_at: 2026-05-23T00:00:00.000Z
related_themes:
  - brain-first-research
  - theme-page-format
  - brain-gap-feedback-loop
---

# Karpathy three-layer LLM wiki

The brain is a Karpathy-style LLM wiki with three layers:

1. **`_raw/`** — immutable raw sources (research, logs, ingested docs). Append-only ground truth. Never modified, never deleted.
2. **`themes/`** — 15-40-line theme pages indexing the raw layer. Annotated source links *are* the index. No paraphrasing of summaries.
3. **Category indexes + `profile.md`** — navigation pointing to theme pages.

After the **Tier 4 three-brain restructure (2026-05-26)**, forge uses three scoped brains:
- **Brain 1 (forge-dev):** `brain/forge-dev/` — forge source + ADRs + engineering notes.
- **Brain 2 (cycles):** `brain/cycles/` — cycle-derived patterns, antipatterns, raw archives.
- **Brain 3 (per-project):** `<project-repo>/brain/` — lives inside each managed project's repo.

The brain is rendered as an **Obsidian vault** so humans navigate the same graph the agents query. Three skills front it: `brain-ingest` (sole writer), `brain-lint` (structural integrity), `brain-query` (efficient lookup).

Karpathy's principle: many small navigable pages > few large summaries. A reader (human or agent) should arrive at the right raw source within 2-3 clicks.

## Sources

- [`karpathy-llm-wiki.md`](../../_raw/web/karpathy-llm-wiki.md) — the canonical Karpathy gist ([gist.github.com/karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)), re-ingested 2026-05-23 in S1.4 (the Pass-A synthesis is archived under `brain/_archive/2026-05-23/karpathy-llm-wiki.chat.md`).
- [`adr-004-obsidian-wiki.docs.md`](../../_raw/docs/adr-004-obsidian-wiki.docs.md) — the brain's structural decision record.

## See also

- [[brain-first-research]] — why the wiki gets used.
- [[theme-page-format]] — theme page format.
- [[brain-gap-feedback-loop]] — how it stays current.
