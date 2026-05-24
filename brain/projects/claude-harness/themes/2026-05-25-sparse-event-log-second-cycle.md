---
title: Sparse event log confirmed structural — second cycle in a row with only reflector.start
description: Two consecutive cycles (claude-trail scaffold + cost-only) both produced events.jsonl containing only the reflector's own start event; all developer-loop and reviewer events are absent. The pattern is now confirmed structural, not a one-off.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sparse event log — confirmed structural gap (second cycle running)

## Observation

`_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` contains:

```json
{"event_type":"start","phase":"reflection","skill":"reflector","message":"reflector.start","..."}
```

One line. No architect events. No developer-loop events. No reviewer events.

This is identical to cycle 1 (`INIT-2026-05-24-claude-trail-scaffold`), which was
documented in theme `2026-05-25-sparse-event-log-observability-gap.md`.

## Why this is now structural, not episodic

The same failure in two consecutive cycles eliminates the "one-off" hypothesis:
- It is not a worktree merge fluke (would vary).
- It is not a phase-specific failure (all phases absent both cycles).
- It is consistent: every phase writes events to a path that is NOT the canonical
  `_logs/<cycle-id>/events.jsonl`.

## Impact on reflection quality

Without structured event data:
- Iteration counts per WI are inferred from git history (fragile).
- Cost breakdown by phase is impossible.
- Wedge detection relies on autocommit timestamps, not actual wedge events.
- The reflector cannot compute the metrics the bench gates on.

Both cycle retros have been constructed from git-log archaeology — this is unsustainable.

## Recommended fix

1. Confirm the canonical event log path and ensure all phase scripts write to it.
2. Add a post-phase assertion: if no events were written, fail loudly before the
   next phase starts.
3. If phases run in worktrees, sync the worktree-local events file back to the
   canonical path as part of the phase teardown.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-cost-only/events.jsonl` — the sparse log (cycle 2)
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-cost-only.md` — cycle 2 archive
- `brain/projects/claude-harness/themes/2026-05-25-sparse-event-log-observability-gap.md` — cycle 1 version of this antipattern
