---
title: Sparse event log — four consecutive cycles confirms operator intervention required
description: Cycle 4 (since-flag) again produced events.jsonl with only reflector.start; four consecutive claude-harness cycles with the same symptom. The brain has flagged this as structural after cycles 2, 3, and now 4 — operator investigation has not been performed. Further brain flagging is insufficient; this requires an operator-level diagnosis.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sparse event log — four-cycle confirmation; operator action overdue

## Observation

`_logs/INIT-2026-05-25-claude-trail-since-flag/events.jsonl` contains exactly one line:

```json
{"event_id":"EV_mpk2t811_edmiu2ea","cycle_id":"INIT-2026-05-25-claude-trail-since-flag",...,"message":"reflector.start"}
```

This is the fourth consecutive cycle with this pattern:

| Cycle | Events in log |
|-------|--------------|
| 1 (scaffold) | `reflector.start` only |
| 2 (cost-only) | `reflector.start` only |
| 3 (git-enrich) | `reflector.start` only |
| 4 (since-flag) | `reflector.start` only |

## Escalation

Prior themes documented this antipattern after cycles 1, 2, and 3:
- `2026-05-25-sparse-event-log-observability-gap.md` — cycle 1
- `2026-05-25-sparse-event-log-second-cycle.md` — cycle 2 "confirmed structural"
- `2026-05-25-sparse-event-log-third-cycle.md` — cycle 3 "forge pipeline bug"

After three brain flags with recommended fixes, no operator action has been taken. This theme is
written to confirm the pattern persists for a fourth cycle and to escalate: **further brain flagging
will not fix this**. The reflector cannot investigate the forge pipeline; only the operator can.

## Impact

All four claude-harness retros have been constructed from git-log archaeology. Key metrics are
permanently unavailable:
- Per-phase cost breakdown
- Per-WI iteration counts (approximated from commit pattern, not exact)
- Wedge event count
- Send-back round count
- Rate-limit retry count

The bench gates that expect structured event data receive only the reflector's own event.

## Required operator action

1. Check what path `orchestrator/phases/dev-loop.ts` writes events to.
2. Verify it equals `_logs/<cycle-id>/events.jsonl` (canonical path).
3. If phases run in worktrees: confirm sync-back step exists and runs.
4. Add a post-phase assertion: if no events were written to the canonical path, fail loudly.

This investigation has been recommended 3 times. It is now overdue.

## Sources

- `_logs/INIT-2026-05-25-claude-trail-since-flag/events.jsonl` — the sparse log (cycle 4)
- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-since-flag.md` — cycle 4 archive
- `brain/projects/claude-harness/themes/2026-05-25-sparse-event-log-third-cycle.md` — cycle 3 version
