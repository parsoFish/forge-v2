---
title: PM brain-query is bounded — re-querying the same index is token waste
description: The PM's `brain-query` invocations get cached against the system-prompt index. Calling brain-query 9+ times on the same cycle (as the 2026-05-23 dogfood did at $1.54 / 8m51s) indicates exploration confusion, not deeper understanding — the SKILL caps it at ≤3 queries.
category: antipattern
created_at: 2026-05-23T12:30:00Z
updated_at: 2026-05-23T12:30:00Z
related_themes:
  - quality-gate-cmd-must-assert-new-work
  - spec-driven-work-items
---

# PM brain-query is bounded

## Sources

- `_logs/2026-05-23T12-18-54_INIT-2026-05-23-release-def-substrate-gates/events.jsonl`
  — 9 `pm.brain-query` tool_use events, $1.54, 8m51s. Result: 5 WIs with
  hidden coupling between WI-1 and WI-5 (overlapping schema file). Cycle
  failed at PM validator (`detectHiddenCoupling`), not at dev-loop.
- Compared to `_logs/2026-05-23T11-43-25_INIT-2026-05-23-release-def-substrate-gates/events.jsonl`
  (the first dogfood attempt against the same manifest): PM completed in
  3m49s, emitted 6 clean WIs. Difference: bounded vs unbounded brain
  exploration.

## What happens when PM over-queries

The PM has the full brain navigation index in its system prompt
(`buildPmSystemPrompt` injects it on every call). Each `brain-query`
invocation runs a sub-Claude call that re-reads against the same index
the PM already has. The marginal value of query N+1 falls off sharply
after N ≈ 2-3.

In the betterado dogfood second attempt, PM ran 9 brain-queries before
emitting WIs. Symptoms:

- 7.5× the cost of the first attempt ($1.54 vs $0.20 estimated).
- 2.3× the wall-clock time (8m51s vs 3m49s).
- WI decomposition WORSE than the first run (hidden-coupling instead of
  clean 6-WI graph).

The exploration didn't pay off — it actively degraded output quality.

## Mitigation (post-2026-05-23)

The PM SKILL now caps brain-query at **≤3 targeted queries**. The hard
mitigation lives in the SKILL prompt; the soft mitigation is that
sub-Claude calls are subject to the PM's own iteration cap (40 turns)
and brain reads burn turns.

For directly-readable themes the PM should use `Read` over `brain-query`
— it's cheaper (one tool call vs a sub-Claude run) and equally accurate
for a known path.

## How to apply

When debugging a PM run that takes >5 minutes:
- Count `pm.brain-query` events in `events.jsonl`. If > 3, the PM is
  over-exploring. Tighten the SKILL prompt OR add a specific note in
  the manifest body steering the PM away from areas it doesn't need.
- A cycle archive that lists 9+ brain-queries with a hidden-coupling
  failure should trigger a SKILL tightening, not a PM re-run.

## See also

- [[quality-gate-cmd-must-assert-new-work]] — the gate-side mitigation
  for the 2026-05-23 dogfood's other failure mode.
- [[spec-driven-work-items]] — what good PM output looks like.
