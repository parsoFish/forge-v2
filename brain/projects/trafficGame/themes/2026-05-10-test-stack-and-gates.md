---
title: trafficGame — test stack is Vitest + Playwright with a strict TDD + visual-test discipline
description: TypeScript strict, Vitest for unit/integration, Playwright for visual; locked CLAUDE.md mandates write-tests-first, ~150 lines per file, no any, no time-based waits. Quality gates for any forge initiative against trafficGame must include both npm test and npm run test:visual where canvas/physics is touched.
category: process
keywords: [trafficgame, vitest, playwright, tdd, visual-test, strict-typescript, claude-md, quality-gate, deterministic, fixed-timestep]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-10T15:30:00Z
related_themes: []
---

# trafficGame — test stack and quality gates

## Stack

- **TypeScript strict mode** (CLAUDE.md "no `any` without justification").
- **Vite** for dev/build (`npm run dev`, `npm run build`).
- **Vitest** for unit + integration tests.
- **Playwright** for visual tests:
  - `npm run test:visual` — headed (slower, debuggable).
  - `npm run test:visual` — headless (CI-shaped).

## CLAUDE.md mandates (locked core)

The project's [`CLAUDE.md`](../../../../projects/trafficGame/CLAUDE.md) carries a **locked core** that any forge initiative against trafficGame must respect:

- **TDD discipline**: write tests first → lock tests → implement until pass → never modify tests to make them pass.
- **`get_errors` (or `npm test`) must be empty** before claiming completion.
- **~150 lines max per file**. Early returns. Explicit dependencies.
- **No `any`** without justification. **No hardcoded positions.** **No random maps in unit tests** — use deterministic test maps. **No time-based waits** for simulation outcomes — use completion-based.
- **User controls git** — agents don't run git commands unless asked. *(Note: the forge cycle's reviewer phase does need to commit + push; treat the mandate as "no destructive `git reset` / `git clean` / `git checkout --` style operations without the user".)*
- **Don't scale individual physics constants** — use `SimulationTimeScale` if speed needs to change.

## Quality gates for forge initiatives against trafficGame

| Work item touches… | Required gate |
|---|---|
| Canvas rendering, vehicle physics, BPR/flow prediction, scoring | `npm test` **and** `npm run test:visual` (or `:visual:fast`) |
| Pure TS utility, types, docs | `npm test` only |
| New campaign data, new map definition | `npm test` (and `:visual:fast` if it ships a renderable map) |
| UI overlay (CanvasScreen subclass) | `npm test` and `npm run test:visual` — the overlays don't surface in unit tests |
| Algorithm-heavy (Steiner, graph-colouring, network optimization) | `npm test` and `:visual:fast`; also flagged for decomposition before queueing (see [`algorithm-heavy-items`](algorithm-heavy-items.md)). |

For the per-WI `quality_gate_cmd` field on the initiative manifest ([`orchestrator/manifest.ts`](../../../../orchestrator/manifest.ts)): the safe default is `["npm", "test"]`. WI-level overrides should add `npm run test:visual` for visual-affecting work.

## Determinism

- Fixed timestep: 60 ticks/s regardless of speed.
- `SimulationTimeScale` controls ticks-per-frame, not delta time → all physics scale uniformly.
- Scoring sim spawns 150 vehicles, waits for all-complete or timeout (typically `timeScale=5`, ~60s wall-clock).

This determinism is what makes Vitest tests trustworthy for traffic behaviour (no flaky physics).

## Self-learning protocol

CLAUDE.md mandates that agents **read `docs/LEARNINGS.md` before acting** and **update it after learning**. For forge initiatives, this maps to:

- The dev-loop reads `docs/LEARNINGS.md` as part of WI prep.
- The reflection phase should write any new failure mode / strategy back to `docs/LEARNINGS.md` (not just the brain) — the project's own self-learning loop is the canonical home for trafficGame-specific tactical knowledge; the brain captures **patterns and themes** about trafficGame.

## Sources

- Project [`CLAUDE.md`](../../../../projects/trafficGame/CLAUDE.md) (locked core + self-learning protocol).
- Project [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) (canonical project-side learnings).
- Project test scripts: `npm test`, `npm run test:visual`, `npm run test:visual`.

## Related

- [`canvas-bpr-flow-tests`](canvas-bpr-flow-tests.md) — Playwright is the orchestrator-verified gate for canvas/BPR.
- [`algorithm-heavy-items`](algorithm-heavy-items.md) — decomposition discipline.
- [`developer-ralph-brain-skip-on-second-wi`](2026-05-10-developer-ralph-brain-skip-on-second-wi.md) — brain-first per-WI discipline.
