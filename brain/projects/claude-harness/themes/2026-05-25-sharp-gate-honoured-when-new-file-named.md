---
title: Sharp-gate honoured when manifest names a specific new test file as the gate condition
description: Cycle 4's gate directive named tests/since-flag.test.ts as the gate condition (fails on clean tree because file doesn't exist); unlike cycle 3 where the mandated integration test was omitted, cycle 4's dev-loop created the file (216 lines, 7 assertions). The distinguishing factor is the manifest naming a file that cannot pre-exist.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sharp-gate honoured when new file named in manifest

## Observation

Cycle 3 (git-enrich) failed to create the mandated `tests/trail-git-activity-integration.test.ts`
despite an explicit gate directive. Cycle 4 (since-flag) succeeded in creating
`tests/since-flag.test.ts` (216 lines, 7 assertions, all passing).

The manifest phrasing in cycle 4:

> Gate: `node --test --experimental-strip-types tests/since-flag.test.ts` — fails on clean tree
> (file doesn't exist).

The key phrase is "fails on clean tree (file doesn't exist)". This tells the dev-loop:
running the gate command without creating the file will fail immediately. The gate is
self-enforcing: it cannot pass by running existing tests.

## Why cycle 4 succeeded where cycle 3 failed

Cycle 3's gate also named a new file, but the gate was embedded in a multi-WI manifest with
additional integration commentary. The cycle 4 manifest's one-WI scope meant the gate condition
was the only acceptance criterion — no alternative path to "tests pass" existed.

Hypothesis: when there is only one WI and one gate, and that gate explicitly fails unless the
named file exists, the dev-loop cannot rationalise skipping file creation.

## Pattern

For any WI requiring a NEW test file:
1. Make the gate command reference that specific file by name.
2. Note "(file doesn't exist yet)" in the gate directive.
3. Keep the WI to a single scope — no other pass-alternative gate.

This combination prevents the substitution failure (agent runs existing tests instead of creating
the required file) documented in `2026-05-25-sharp-gate-omission.md`.

## Contrast

- Cycle 3 sharp-gate: omitted (4-file WI with complex retry context + separate WI for tests).
- Cycle 4 sharp-gate: honoured (1-file WI, single gate, explicit "doesn't exist" note).

## Sources

- `_logs/INIT-2026-05-25-claude-trail-since-flag/events.jsonl` — cycle 4 event log (commit `b370931` confirms test file creation)
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-since-flag.md` — cycle 4 archive
- `brain/projects/claude-harness/themes/2026-05-25-sharp-gate-omission.md` — cycle 3 failure for contrast
