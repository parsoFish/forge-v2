---
name: brain-ingest
description: Append raw sources to the brain and create or update theme pages. Never modifies raw in place; never deletes.
phase: brain
surface: unattended
model: claude-sonnet-4-6
---

# Brain — Ingest

## Single responsibility

The only writer to the brain. Takes raw input (text, URL contents, cycle logs, retros, research) and:

1. Appends the raw to `brain/_raw/` with full provenance.
2. Creates new theme pages or appends to existing ones in `brain/cycles/themes/` (forge-wide) or `projects/<name>/brain/themes/` (project-specific).
3. Updates category indexes.
4. Appends an entry to `brain/forge-dev/log.md`.

## Required first action

Invoke `brain-query` with:

- "Does the brain already have a theme on <topic>?"
- "Are there raw sources already in `_raw/` that overlap with what's about to be ingested?"

This avoids creating duplicate themes or re-ingesting overlapping raw.

## Inputs

- A source identifier: URL, file path, or inline content.
- Optional: target category (`pattern`, `antipattern`, `decision`, `operation`, `reference`).
- Optional: target project (for project-scoped ingest).

## Outputs

- New `brain/_raw/<...>.md` (with mandatory frontmatter — see [`brain/_raw/README.md`](../../brain/_raw/README.md)).
- New or updated `brain/cycles/themes/<slug>.md` or `projects/<name>/brain/themes/<slug>.md`.
- Updated category index (`brain/cycles/<category>.md` or `projects/<name>/brain/<category>.md`).
- Append to `brain/forge-dev/log.md`.

## Event-log entries to emit

- `brain-ingest.start` — with source identifier.
- `brain-ingest.raw-appended` — file path written.
- `brain-ingest.theme-created` or `brain-ingest.theme-updated` — slug + category.
- `brain-ingest.index-updated` — which category index.
- `brain-ingest.end`.

## Process

1. **Brain query first** to check for overlap.
2. Fetch / load the source. Clean (de-paginate, ad-strip) but preserve content.
3. Write to `brain/_raw/<source-type>/<slug>.<source-type>.md` with mandatory frontmatter.
4. Decide: does this fit an existing theme, or does it warrant a new one?
   - **Fit existing:** append the new source link with a one-line annotation. Do not paraphrase the new source's content into the theme page; the source link is the index.
   - **New theme:** create `brain/cycles/themes/<slug>.md` (or project-scoped) following the format in [`brain/cycles/themes/README.md`](../../brain/cycles/themes/README.md). Add to the relevant category index.
5. Append to `brain/forge-dev/log.md`: `## [<YYYY-MM-DD>] ingest | <source-type>: <slug>`.

## Constraints

- **Append-only on raw.** Never modify a `_raw/` file after creation. Corrections are new raw sources with theme-page notes about supersession.
- **No paraphrasing.** Theme pages link to and annotate raw; they don't summarise it.
- **Many small theme pages > few large summaries.** If a topic doesn't fit in 40 lines, split.
- **Re-themable.** When ingesting v1 wiki content (Pass B), the agent decides what's still relevant under v2's conventions. v1-specific content (e.g. job-queue tuning) is rejected at ingest with a log note.
