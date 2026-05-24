---
title: Dev-loop omitted mandated sharp-gate integration test despite explicit manifest directive
description: Cycle 3's manifest explicitly named the "SHARP-GATE integration pattern" and required tests/trail-git-activity-integration.test.ts as WI-2's gate; the dev-loop delivered the feature correctly (golden updated, tests pass) but never created the mandated file — the reviewer accepted without flagging the miss.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sharp-gate omission — mandated integration test not created

## Observation

The manifest for cycle 3 (`INIT-2026-05-25-claude-trail-git-enrich`)
contained an explicit directive:

> **Gate: `node --test --experimental-strip-types tests/trail-git-activity-integration.test.ts`**
> — fails on clean tree because the file doesn't exist yet, AND even
> once it exists it'll fail until cli.ts is wired. Only passes when ALL
> of: test file present + cli wired + golden updated. This is the
> SHARP-GATE integration pattern.

Post-merge, `tests/trail-git-activity-integration.test.ts` does not exist.
The feature shipped correctly (golden updated, 46/46 pass, cli.ts wired),
but via existing tests — not the mandated new integration file.

## Why this matters

The SHARP-GATE directive was added specifically because cycle 2A's
WI-2 gate (renderer unit test only) passed before CLI wiring was
complete. The integration test was designed to be the verification
that CLI wiring actually happened. Its absence means:

1. The gate protection designed to prevent regression is absent.
2. A future WI could accidentally revert the wiring and the omitted
   test file would provide no safety net.
3. The manifest's explicit architectural intent (integration coverage)
   was not fulfilled — the feature works now but lacks the test
   infrastructure it was supposed to ship with.

## Failure mode

The dev-loop appears to satisfy the gate criterion by running existing
tests (which pass because the feature was correctly implemented) rather
than by creating the new test file the gate was meant to require.
If the gate was specified as a new filename (which doesn't exist on clean
tree), `node --test tests/trail-git-activity-integration.test.ts` would
exit non-zero, preventing premature gate passage. It appears the PM or
dev-loop substituted a looser gate without creating the required file.

## Recommended fix

1. Gate conditions that specify a NEW file should fail if that file
   does not exist, not just if the test fails. Add a pre-gate assertion:
   `[ -f <gate-path> ] || exit 1`.
2. The reviewer's checklist should include: "does the WI spec list a
   required new test file? If so, does it exist in the diff?"
3. Manifest directives that say "create a NEW test file named X" are
   higher-priority than "tests pass" — treat them as spec deliverables,
   not hints.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-git-enrich/events.jsonl` — cycle 3 log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-git-enrich.md` — cycle 3 archive
