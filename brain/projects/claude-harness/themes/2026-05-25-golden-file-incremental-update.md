---
title: Incremental golden-file update succeeds for section additions between existing sections
description: WI-2 required inserting a new `## Cost rollup` section into an existing golden file between `## Phases` and `## Themes consulted`; the dev-loop did so correctly and the byte-for-exact CLI match held — confirming binary acceptance works for incremental feature additions, not only initial scaffolding.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Golden-file incremental update pattern

## Observation

Cycle 1 established that golden-file binary acceptance works for initial scaffolding.
Cycle 2 extended this: WI-2 required inserting a new `## Cost rollup` section between
`## Phases` and `## Themes consulted` in the existing
`tests/fixtures/INIT-FIXTURE-1.trail.golden.md`.

The fixture's events.jsonl was also updated (adding `cost_usd` fields to 2-3 events)
to give the cost section non-trivial data.

Post-merge: `npm test` exits 0, 36/36 pass. The CLI stdout against the augmented
fixture matches the updated golden byte-for-byte.

## What this confirms

- Section insertion does not break structural stability of existing golden content.
- The fixture is the authoritative spec: updating it during the WI that introduces
  the feature creates a "spec-and-test in one commit" artefact.
- Path-normalised golden-file matching (from cycle 1) extends to the new section
  without additional normalisation logic — the cost section contains no absolute paths.

## When to update the golden vs create a new fixture

- **Update existing golden**: adding a new section to the existing output shape.
- **New fixture**: changing the meaning of an existing section, or testing a
  fundamentally different input scenario.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-cost-only.md` — cycle archive
