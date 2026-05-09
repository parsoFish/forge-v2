---
initiative_id: INIT-2026-05-09-slugifier-basic
project: slugifier
project_repo_path: /tmp/slugifier
created_at: 2026-05-09T11:00:00Z
iteration_budget: 50
cost_budget_usd: 25
phase: in-flight
features:
  - feature_id: FEAT-1
    title: Core slugify(input) helper
    depends_on: []
  - feature_id: FEAT-2
    title: Batch helpers — slugifyMany + uniqueSlug
    depends_on: [FEAT-1]
  - feature_id: FEAT-3
    title: Configurable separator + max-length option
    depends_on: [FEAT-1]
---

# Initiative: URL-safe slugifier — core + batch helpers + configurability

The downstream content pipeline indexes posts by URL slug. Today, two callers (the index builder
and the link renderer) each roll their own slug logic, producing divergent slugs for the same
title and dead-linking each other. This initiative replaces that drift with a single canonical
slugifier package that covers the three caller needs: producing one slug, producing many at once
without collisions, and tuning the output for callers that need a non-default separator or a
length cap.

## Features

### FEAT-1 — Core `slugify(input)` helper (no dependencies)

`src/slugify.ts` exports `slugify(input: string): string` that converts an arbitrary string to a
URL-safe slug:

- Lower-case ASCII output.
- Words separated by hyphens (`-`).
- Numbers preserved.
- Latin accents normalised (`é → e`, `ñ → n`, etc.) via NFD + combining-mark strip.
- Non-Latin characters and emoji dropped (not transliterated).
- Multiple consecutive non-alphanumeric runs collapse to a single hyphen.
- Leading and trailing hyphens trimmed.
- Empty input returns empty string (not throw, not null).

Tests in `tests/slugify.test.ts` cover all eight rules including edge cases (empty input, emoji,
non-Latin scripts, consecutive separators).

### FEAT-2 — Batch helpers (`slugifyMany`, `uniqueSlug`) — depends on FEAT-1

The index builder slugifies a list of titles and needs to disambiguate collisions. Two helpers
in `src/batch.ts`:

- `slugifyMany(inputs: string[]): string[]` — applies `slugify` element-wise. Trivial wrapper but
  named for the caller's intent.
- `uniqueSlug(slug: string, taken: string[]): string` — given a candidate slug and a list of
  already-taken slugs, returns either the original slug (if not taken) or the slug appended with
  the smallest integer suffix `-N` that is not in `taken`. Examples: `uniqueSlug('foo', [])` →
  `'foo'`; `uniqueSlug('foo', ['foo'])` → `'foo-2'`; `uniqueSlug('foo', ['foo', 'foo-2'])` → `'foo-3'`.

Tests in `tests/batch.test.ts` cover both helpers including the suffix-disambiguation cases.

### FEAT-3 — Configurable options (`SlugifyOptions`) — depends on FEAT-1

The link renderer wants underscores instead of hyphens in some contexts and a length cap in others.
Extend `slugify` to accept an optional second argument:

- `src/slugify.ts` exports `type SlugifyOptions = { separator?: string; maxLength?: number }`.
- `slugify(input: string, options?: SlugifyOptions): string` — when `options.separator` is given,
  use it instead of `-`. When `options.maxLength` is given (positive integer), truncate the output
  to that many characters and re-trim trailing separator if the truncation cut mid-word.
- Default behaviour (no options) is unchanged from FEAT-1.

Tests in `tests/options.test.ts` cover both options and the no-options-equals-FEAT-1 case.

## Why now

Three callers, three half-implemented slugifiers, dead links in production. A single canonical
package with clear scope owners (core / batch / options) is the smallest unblocking change.

## Out of scope

- Pluggable transliteration tables (still drop non-Latin; future work).
- Locale-aware lowercasing.
- Slug uniqueness across a corpus persisted to storage (caller's responsibility — `uniqueSlug`
  takes the taken-list as an argument; persistence is up to the caller).
