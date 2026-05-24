---
title: Retry framing with explicit gate-tightening directive resolved cycle-2A failure
description: When cycle 2A's WI-2 gate was too loose (renderer unit test passing before CLI was wired), labelling the follow-up as a "retry" and embedding a SHARP-GATE integration-level gate directive in the manifest produced a clean ship — zero send-backs, feature fully wired.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Retry framing with gate-tightening resolves prior failure

## Observation

Cycle 2A (INIT-2026-05-25-claude-trail-git-enrich's predecessor) failed
because WI-2's acceptance gate verified only the renderer (`renderGitActivity`
unit test), not the CLI wiring. The unifier identified the gap but could not
close it within the iteration budget.

The retry manifest (this cycle) made two changes:

1. **Framing**: annotated the manifest header with "Cycle 2B retry" and
   explicitly named the prior failure mode: "WI-2's gate verified only the
   renderer (unit test), not the CLI wiring + golden."

2. **Gate directive**: replaced the renderer-unit-test gate with an
   integration-level gate running
   `tests/trail-git-activity-integration.test.ts`, with inline commentary
   explaining WHY it was sharp: "fails on clean tree because the file
   doesn't exist yet, AND even once it exists it'll fail until cli.ts is
   wired."

Result: the feature shipped cleanly. 46/46 tests pass. CLI wired. Golden
updated. Zero reviewer send-backs. The retry cost was one additional cycle
rather than additional iterations in the same cycle.

## Why this works

- Naming the prior failure mode in the manifest brief gives the PM and
  dev-loop context they wouldn't otherwise have (no event log from the
  failed run).
- An integration-level gate that exercises the full execution path (spawn
  CLI → assert stdout) cannot pass unless all layers are wired — unlike a
  unit test that can pass when only one layer is implemented.
- Retry framing avoids re-accumulating the same multi-WI integration debt:
  the new cycle starts from the current state of the repo and the learnings
  from the failure are embedded in the spec.

## When to apply

Use this pattern when:
- A prior cycle failed at a late gate (reviewer send-back or gate failure)
  because an earlier gate was too loose.
- The unifier or reviewer can articulate the specific gap.
- The fix is to tighten one gate condition, not to redesign the feature.

## Caveats

The SHARP-GATE directive in this cycle was not fully honoured (the mandated
integration test file was not created; see `2026-05-25-sharp-gate-omission.md`).
The pattern still succeeded because the CLI was correctly wired — but the
long-term regression coverage was not established. Retry framing + gate
directive is necessary but not sufficient; the gate must actually be enforced.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-git-enrich/events.jsonl` — cycle 3 log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-git-enrich.md` — cycle 3 archive
