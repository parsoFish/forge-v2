---
title: trafficGame — recent extractions reduced Game.ts and what tech debt remains
description: Apr–May 2026 work split NetworkOptimizer, extracted NetworkAnalysisService/VisibilityManager/GameToolManager out of Game.ts, archived MCP server, removed 264-line dead TrafficPointEntity. Game.ts is still ~1,732 lines and TrafficMap.ts is still 517 — these are the priority extractions left.
category: snapshot
keywords: [trafficgame, refactor, extraction, game-ts, network-optimizer, visibility-manager, game-tool-manager, scoring-coordinator, tech-debt, steiner, graph-coloring]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-10T15:30:00Z
related_themes: []
---

# trafficGame — recent extractions and remaining tech debt

## What landed in the recent refactor cycle

From git log on `projects/trafficGame/` (commits `99a0162` ← `f4977de` ← `6cb1015` ← `29ed8f2` ← `37bb247` ← `b931e47` ← `4d5cb3a`), and from [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) §"Refactoring Log":

| Change | Outcome |
|---|---|
| Removed dead "PHASE 10d: smart network planning" code from Game.ts | Game.ts: 2,706 → 2,160 lines |
| `NetworkAnalysisService` extraction (`src/game/NetworkAnalysisService.ts`, 385 lines) | Game.ts: 2,160 → 1,732 lines |
| `VisibilityManager` extraction from Game.ts | Visibility logic owns its own module |
| `GameToolManager` extraction from Game.ts | Tool orchestration owns its own module |
| `NetworkOptimizer.ts` split (727 → 510 + 112 + 111) | Types and helpers are separately importable |
| `NetworkOptimizer` strategy replaced with **Steiner topology + graph colouring** | New strategy lives in same file |
| `RoadNetwork` caching via `getNetwork()` | Eliminates ~60 adjacency-list rebuilds/sec during simulation |
| Material cost consolidated to single `UnifiedScore.calculateMaterialCost()` | `Road.ts` and `ScoreCalculator.ts` delegate |
| Map definitions extracted to `src/traffic/MapDefinitions.ts` | TrafficMap.ts: 677 → 517 lines |
| `ReferenceSolution` import/export | New `MCP game_export_solution` / `game_import_solution` |
| Removed `TrafficPointEntity.ts` (264 lines unused parallel abstraction) + 15 dead tests | Test count: 516 → 501, all passing |
| Removed entire `mcp-server/` directory | MCP archived to `mcp-server/README.md` only |
| `getRoadNetwork()` removed `as any` cast | `Object.create(network)` wrapper instead |

## Tech debt prioritized for future sessions

From the explicit list at [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) §"Remaining tech debt":

| Priority | Issue | Lines | Impact |
|---|---|---|---|
| P2 | TrafficMap.ts still 517 lines — class does map gen + flow analysis | 517 | SRP violation |
| P2 | GameRenderState has 32 fields — over-coupled render interface | — | Coupling concern |
| P2 | Game.ts still ~1,732 lines — further extraction possible (RoadBuilder, input handling) | ~1,732 | Maintainability |
| P3 | SimulationTimeScale deprecated methods kept because tests use them | 72 | Minor cleanup |

## Why this matters for the architect

- **Architect proposals should respect the cap of ~150 lines per file** (project CLAUDE.md). Anything that lands >150 lines in a single new file is a smell.
- **Don't widen Game.ts.** It's already on the tech-debt list. New systems should land in their own modules and be referenced from Game.ts via thin delegations.
- **Steiner + graph-colouring is recent and load-bearing.** Any traffic / network-strategy work has to play nicely with the new optimizer; don't propose a parallel strategy without a strong reason.
- **MCP is archived.** Don't propose initiatives that re-introduce MCP tools; the project chose to remove them.

## Sources

- Recent git log on `/home/parso/forge/projects/trafficGame/`.
- Project [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) §"Refactoring Log (Feb 2026 Session)" + §"Session 2 refactoring".

## Related

- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — current src/ shape.
- [`algorithm-heavy-items`](algorithm-heavy-items.md) — Steiner is the canonical algorithm-heavy precedent.
- [`test-stack-and-gates`](2026-05-10-test-stack-and-gates.md) — `~150 lines per file` is enforced via review, not a linter.
