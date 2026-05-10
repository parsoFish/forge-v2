---
title: trafficGame — minimal pure-utility initiatives complete in 1 developer iteration
description: Tightly-scoped pure-function additions to core utilities (single file, concrete numeric acceptance criteria, strict TypeScript) reliably complete in 1 developer-ralph iteration with no wedge events.
category: pattern
keywords: [trafficgame, developer-ralph, utility, single-iteration, pure-function, Vector2, acceptance-criteria]
created_at: 2026-05-10T03:23:11Z
updated_at: 2026-05-10T03:23:11Z
related_themes: []
---

# Minimal pure-utility initiatives complete in 1 developer iteration

## Pattern

When a trafficGame initiative is scoped as:
- A **single pure function** added to an existing core utility file (e.g. `src/core/Vector2.ts`).
- **Concrete numeric acceptance criteria** (e.g. `manhattanDistance({x:0,y:0},{x:3,y:4}) === 7`).
- **Tests in the existing test file** matching the project's `describe`/`it` style.
- **No canvas, physics, or BPR-flow changes**.
- **TypeScript strict mode** with no `any` escape hatches.

…the developer-ralph agent completes the WI in exactly 1 iteration with quality-gates-pass and no wedge events.

## Evidence

Cycle `2026-05-10T03-08-21` — WI-1 (add `manhattanDistance` to Vector2):
- 1 iteration, quality-gates-pass.
- 6 reads, 3 brain reads, 17 bash calls, 1 test run.
- Cost $0.447.
- Duration ~4 min 17 sec.
- No send-backs from reviewer on the WI-1 implementation itself.

## Design implication for initiative scoping

This pattern is the ideal shape for "round out the math API" type work. The PM should recognise this shape and keep it as a single WI (not split into "add function" + "add tests" sub-items — tests belong in the same atomic WI as the implementation). Splitting adds multi-WI risk (brain-skip on WI-2; see related theme).

## Sources

- `_logs/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5/events.jsonl` — event `EV_moz7btsl_zamzjvco` (ralph.end WI-1, iterations: 1, stop_reason: quality-gates-pass).
- `/home/parso/forge/brain/_raw/cycles/2026-05-10T03-08-21_INIT-2026-05-10-trafficgame-manhattan-v5.md`

## Related

- [Theme: algorithm-heavy items must be decomposed](./algorithm-heavy-items.md) — the opposite failure mode: too-large items wedge.
