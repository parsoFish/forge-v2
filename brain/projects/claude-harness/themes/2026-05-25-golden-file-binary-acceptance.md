---
title: Golden-file binary acceptance criterion eliminated reviewer taste judgement
description: Requiring stdout to match a frozen golden file byte-for-byte made the reviewer's verdict mechanical and unambiguous; no taste judgement was needed and send-back risk from subjective criteria was eliminated.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Golden-file binary acceptance criterion

## Observation

The cycle-1 acceptance criterion was: given a frozen fixture, when the CLI
runs, then stdout matches `tests/fixtures/INIT-FIXTURE-1.trail.golden.md`
byte-for-byte. The operator's architect interview answer: "Acceptance is
binary, no taste judgement."

28 tests passed on `de26e77`. The reviewer could verify the criterion by
running `npm test` and seeing exit 0 — no reading of prose, no aesthetic
assessment.

## Why this works for CLIs with deterministic output

- Reviewer send-back risk is eliminated for the tested behaviour.
- Regressions across future cycles are caught automatically.
- The golden file doubles as living specification: its content shows
  exactly what the CLI emits, section by section.
- Path-normalised matching (replacing absolute paths with a placeholder)
  handles machine-dependent paths without losing structural coverage.

## Applicability

Works well when:
- Output is deterministic given frozen inputs.
- The output format is the primary correctness signal (markdown CLIs,
  code generators, report tools).

Less useful when:
- Output includes timestamps or non-deterministic fields.
- Correctness is about behaviour, not textual output.

## Sources

- `_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-24-claude-trail-scaffold.md` — cycle archive
