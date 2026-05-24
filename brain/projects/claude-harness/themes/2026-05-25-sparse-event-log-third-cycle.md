---
title: Sparse event log — three consecutive cycles confirms forge pipeline bug, not edge case
description: Cycle 3 (git-enrich) again produced events.jsonl with only reflector.start; three consecutive cycles with the same symptom eliminates all one-off and worktree-fluke hypotheses and confirms a persistent forge pipeline misconfiguration.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sparse event log — three-cycle confirmation

## Observation

`_logs/INIT-2026-05-25-claude-trail-git-enrich/events.jsonl` contains
exactly one line:

```json
{"event_id":"EV_mpk0pl06_qr42llwv","cycle_id":"INIT-2026-05-25-claude-trail-git-enrich",...,"message":"reflector.start"}
```

This is the third consecutive claude-harness cycle with the same pattern:

| Cycle | Events in log |
|-------|--------------|
| 1 (scaffold) | `reflector.start` only |
| 2 (cost-only) | `reflector.start` only |
| 3 (git-enrich) | `reflector.start` only |

## Why three cycles matters

- Eliminates "worktree merge fluke" — if it were a merge artefact it
  would vary cycle-to-cycle.
- Eliminates "phase-specific failure" — all phases are absent in all
  three cycles.
- Eliminates "one-off pipeline hiccup" — three consecutive cycles is
  a systematic misconfiguration.

## Current impact

All three claude-harness retros have been constructed from git-log
archaeology (commit messages, file diffs) rather than structured
event data. This means:
- Per-WI iteration counts are approximated, not precise.
- Cost breakdown by phase is impossible.
- Wedge events and send-back rounds cannot be counted or attributed.
- The bench gates that read `events.jsonl` get only the reflector's
  one event.

## Root cause hypothesis (updated after 3 cycles)

The architect, PM, dev-loop, and reviewer phases all write events to a
path that is NOT `_logs/<cycle-id>/events.jsonl`. Candidates:
- A worktree-local path that is never synced back.
- A different cycle-id derivation in phase scripts.
- Events written to a temp buffer that is not flushed to disk before
  phase teardown.

## Required fix

Operator-level investigation needed. Check:
1. What path does `orchestrator/phases/dev-loop.ts` write events to?
2. Does that path equal `_logs/<cycle-id>/events.jsonl`?
3. If phases run in worktrees, is there a sync step?

## Sources

- `_logs/INIT-2026-05-25-claude-trail-git-enrich/events.jsonl` — cycle 3 sparse log
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-git-enrich.md` — cycle 3 archive
- `brain/projects/claude-harness/themes/2026-05-25-sparse-event-log-second-cycle.md` — cycle 2 version
- `brain/projects/claude-harness/themes/2026-05-25-sparse-event-log-observability-gap.md` — cycle 1 version
