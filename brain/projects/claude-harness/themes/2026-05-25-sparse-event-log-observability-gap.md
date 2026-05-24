---
title: Sparse event log — only reflector.start recorded for entire cycle
description: The cycle's events.jsonl contained only the reflector's own start event; all developer-loop, reviewer, and prior-phase events were absent, leaving the reflector unable to compute per-phase cost, iterations, wedge events, or send-back rounds.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Sparse event log — observability gap

## Observation

`_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` contains exactly
one event line: `reflector.start`. All developer-loop, reviewer, architect,
and PM events are absent.

## Why this matters

The reflector's self-reflection stage depends on the event log as its primary
evidence source. Without per-phase events, the reflector cannot:

- Compute per-WI iteration counts or cost breakdown
- Detect wedge events or send-back rounds
- Identify rate-limit retries or stuck loops
- Attribute token spend to phases/skills

The manifest's `previous_failure_modes: requeued-from-failed × 6` could have
been diagnosed from a complete event log; without it the root cause is opaque.

## Consequence

Cycle-1 retrospective is largely inferred from git history rather than the
event log. This is fragile: git messages are less structured than events.

## Root cause hypothesis

The developer-loop and reviewer phases may have run against a different
events.jsonl path (e.g. a worktree-local copy that was not merged back), or
the phases did not emit events at all due to an early pipeline failure.

## Recommended fix

Ensure all phases emit their events to the canonical
`_logs/<cycle-id>/events.jsonl` path, not a worktree-local shadow. Add a
post-merge step that asserts the event log contains at least one event
per phase that ran.

## Sources

- `_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` — the sparse log itself
- `brain/_raw/cycles/INIT-2026-05-24-claude-trail-scaffold.md` — cycle archive
