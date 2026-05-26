---
title: Theme page format
description: >-
  15-40 line markdown file with mandatory frontmatter, ≥1 source link, ≤60 lines
  (warn) / 100 (error). Slug = filename. Indexed in exactly one category index.
category: operation
keywords:
  - theme-page
  - format
  - frontmatter
  - slug
  - lint
  - structure
created_at: 2026-05-04T18:00:00.000Z
updated_at: 2026-05-04T18:00:00.000Z
related_themes:
  - karpathy-three-layer-wiki
---

# Theme page format

Every theme page in the brain's middle layer follows the same shape:

```markdown
---
title: <short title>
description: <one-line description; appears in category indexes>
category: pattern | antipattern | decision | operation | reference
keywords: [list, of, search, terms]
created_at: <ISO-8601>
updated_at: <ISO-8601>
related_themes: [other-theme-slug-1, other-theme-slug-2]
---

# <Title>

<One short paragraph framing the theme.>

<1-2 paragraphs of context — why this matters, when it applies.>

## Sources

- A source entry is a markdown link with the file path as display text and a relative path as href, followed by a one-line annotation.

## Rules

- **15-40 lines** (length cap warns at 60, errors at 100).
- **No summarisation of summaries** — link to raw, don't paraphrase other themes.
- **Annotated source links** — each source link gets a one-line "what's in this file" annotation. The annotations *are* the index.
- **Mandatory frontmatter** — `brain-lint` rejects pages with missing fields.
- **Slug = filename** — `tdd-atomic-items.md`, not `TDD Atomic Items.md`.
- **Indexed in exactly one category index** — the file with `category: pattern` appears once on `forge/patterns.md`.

## Sources

- [`brain/cycles/themes/README.md`](./README.md) — the canonical format definition (in-repo).
- [`brain/LINT.md`](../../LINT.md) — structural rules `brain-lint` enforces.
- [`karpathy-llm-wiki.md`](../../_raw/web/karpathy-llm-wiki.md) — the philosophy underneath the format (canonical gist, re-ingested 2026-05-23).

## See also

- [[karpathy-three-layer-wiki]] — karpathy three-layer llm wiki.

## See also

- [[karpathy-three-layer-wiki]] — the structural context.
