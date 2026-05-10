---
title: trafficGame — developer-ralph skips brain-first on second WI in multi-WI runs
description: In multi-WI cycles, developer-ralph reliably consulted the brain for WI-1 but skipped it entirely for WI-2, triggering an automatic fail; the brain-first mandate must be enforced per-WI, not per-cycle.
category: antipattern
keywords: [trafficgame, developer-ralph, brain-first, multi-wi, brain-skip, mandate, WI-2]
created_at: 2026-05-10T03:23:11Z
updated_at: 2026-05-10T03:23:11Z
related_themes: []
---

# developer-ralph skips brain-first on second WI in multi-WI runs

## What happened

In cycle `2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5`, FEAT-1 was decomposed into 2 work items (WI-1, WI-2).

- **WI-1**: developer-ralph made 3 brain reads, completed 1 iteration, passed quality gates.
- **WI-2**: developer-ralph made **0 brain reads, 0 writes, 0 bash calls** — the runner gate detected `brain-first mandate not honoured` (event `EV_moz7bym4_0cwjpif4`) and failed the WI instantly in 6 seconds at $0.

This is a consistent risk in multi-WI cycles: the brain-first mandate may be treated by the agent as a session-level property (checked once, then "done") rather than a per-work-item requirement.

## Impact

WI-2 produced no code, no commits, no output. Any functionality it was meant to add was silently dropped from the merged result. The review phase merged the partial implementation without flagging the missing WI-2 work explicitly.

## Mitigation

- **Orchestrator**: enforce the brain-first gate independently for each WI invocation; a per-WI counter, not a per-session aggregate.
- **Developer-ralph prompt**: make clear that brain reads are required before ANY work begins, even if a prior WI in the same session already consulted the brain.
- **PM**: when FEAT-1 is decomposed into sequential WIs, consider whether WI-2's work is truly separable. If WI-1 and WI-2 are tightly related (e.g. implementation + cleanup), a single WI may be safer than a two-item run.

## Sources

- `_logs/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5/events.jsonl` — event `EV_moz7bym4_0cwjpif4` (`developer-ralph.brain-skipped`, WI-2) and `EV_moz7bym5_045ctcxi` (ralph.end, status: failed, brainReads: 0).
- `/home/parso/forge/brain/_raw/cycles/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5.md`
