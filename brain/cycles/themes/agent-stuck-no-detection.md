---
title: Agent stuck without detection — silent build/test loops
description: >-
  12 developer timeouts/day at $8-12 waste in v1, agents cycling through the
  same build failure with no file changes. >5 turns no-progress is the
  heuristic; capture diagnostic on timeout.
category: antipattern
keywords:
  - stuck
  - silent-loop
  - timeout
  - no-progress
  - diagnostic-capture
  - wedged
  - $8-12-waste
created_at: 2026-05-04T19:30:00.000Z
updated_at: 2026-05-04T19:30:00.000Z
related_themes:
  - wedged-loop-detector
  - rate-limit-no-backoff
  - design-is-the-bottleneck
---

# Agent stuck without detection — silent build/test loops

On a single day in v1 Cycle 3 (2026-04-04), **12 developer timeouts** were recorded at an estimated waste of **$8–12**. These agents hit the 30-minute wall-clock limit while cycling through the same build or test failure repeatedly, making no meaningful file changes — the orchestrator had no way to know.

Heuristic: if an agent makes **>5 consecutive turns with no file changes** (no Edit, Write, or meaningful Bash output), flag as stuck. On timeout or stuck detection, capture a diagnostic snapshot:

- Last N lines of agent output.
- `git diff` of current changes.
- Which tests failed.
- Resource state (memory, disk).

Secondary benefit — **learning generation**: each stuck event produces a structured learning (project, work item, root-cause category: build-failure-loop / test-flake / resource-exhaustion / unclear-acceptance-criteria) that feeds back into planning improvements.

Agents can also self-report: *"If you are unable to make progress after 5 attempts at the same error, output STUCK: <structured diagnosis>."*

In v2 the wedged-loop detector in [`loops/ralph/stop-conditions.ts`](../../../loops/ralph/stop-conditions.ts) implements this heuristic: 3 consecutive iterations with no `fix_plan.md` progress AND no files changed → wedged. The diagnostic-capture and learning-generation surface land in the reflector skill.

## Sources

- [`v1-themes-failure-modes.cycle.md`](../../_raw/v1-wiki/v1-themes-failure-modes.cycle.md) — full design + Cycle 3 numbers.

## See also

- [[wedged-loop-detector]] — v2's implementation.
- [[rate-limit-no-backoff]] — sister waste category.
- [[design-is-the-bottleneck]] — root cause for many "stuck" events is unclear acceptance criteria.
