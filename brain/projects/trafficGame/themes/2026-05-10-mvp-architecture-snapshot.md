---
title: trafficGame — MVP architecture snapshot (May 2026, post-extraction)
description: Current src/ tree, key extracted services (NetworkAnalysisService, NetworkOptimizer split, VisibilityManager, GameToolManager), and what survives unchanged from the MVP doc. Use this to ground any architect proposal in the real present-day shape.
category: snapshot
keywords: [trafficgame, architecture, src-structure, network-analysis-service, network-optimizer, visibility-manager, game-tool-manager, post-extraction, mvp]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-17T00:00:00Z
related_themes: []
---

# trafficGame — MVP architecture snapshot (May 2026)

The canonical MVP_ARCHITECTURE.md ([raw archive](../../../_raw/projects/trafficGame/2026-05-10-mvp-docs.md#mvp-architecture)) describes the *MVP* layout — accurate for the core data flow but stale on the larger services that have been extracted since.

## Module structure (today)

```
src/
├── Game.ts                  # Was 2,706 lines → ~1,732 after Network/Tool/Visibility extractions
├── core/                    # Vector2, PathSmoothing — unchanged from MVP
├── roads/                   # Road, ConnectionPoints — unchanged
├── input/                   # LineTool, CurveTool, MoveTool, DeleteTool — unchanged
├── traffic/
│   ├── TrafficPoint.ts      # TrafficLocation { entryPoint, exitPoint } (see traffic-location-data-model.md)
│   ├── CarFollowing.ts      # IDM-inspired model (see traffic-physics-and-flow.md)
│   ├── MapGenerator.ts, MapDefinitions.ts, FlowConfig.ts
│   ├── NetworkOptimizer.ts (510 lines) + NetworkOptimizerTypes.ts (112) + NetworkOptimizerHelpers.ts (111)
│   └── ...
├── network/                 # RoadNetwork, A* pathfinding, NetworkDemand.ts (shared O-D routing)
├── rendering/               # Canvas drawing
├── scoring/
│   ├── UnifiedScore.ts      # Single source of truth for prediction + simulation scoring
│   └── FlowCapacitySegment.ts  # Single capacity formula (was 3 divergent impls)
├── game/
│   ├── NetworkAnalysisService.ts  # 385 lines, extracted from Game.ts
│   ├── GameRenderer.ts            # Render loop
│   ├── GameToolManager.ts         # Recently extracted from Game.ts
│   ├── VisibilityManager.ts       # Recently extracted from Game.ts
│   ├── GameSimulationController.ts
│   └── ScoringCoordinator.ts
├── ui/                      # CanvasScreen base + 9 screens (see ui-canvas-overlay-pattern.md)
├── campaign/                # CampaignGraph + campaignGraphData + WorldEdge + WorldSimulator + WorldNode + CampaignPersistence + CampaignTypes (CampaignLevels.ts DELETED — see campaign-mode-state.md)
├── solutions/               # ReferenceSolution.ts (export/import game state)
└── types/
```

## What's load-bearing for any architect proposal

- **Connection points are the source of truth for geometry.** Roads reference connection points by ID; geometry is *computed* from connection points + curve control points. Don't propose changes that store derived data.
- **One scoring model** (`UnifiedScore`) covers both prediction and simulation. New systems must integrate with it, not introduce a parallel score.
- **One capacity formula** (`FlowCapacitySegment`). Pre-sim and live use the same formula now (used to be three divergent implementations — that bug class is closed).
- **One A\* routing loop** (`NetworkDemand.analyzeNetworkDemand`). Used by PredictiveHeatmap, FlowCapacityNetwork, and TrafficMap. Don't add a fourth.
- **NetworkAnalysisService** is the agent-facing analysis surface — anything that wants to inspect "what's the current state of the network and what should we build next?" goes through it.
- **Game.ts is still ~1,732 lines** (down from 2,706). Further extraction is on the tech-debt list (RoadBuilder, input handling) — don't widen Game.ts more.

## Recent (Apr–May 2026) refactor history

- Removed ~630 lines of dead "smart network planning" code from Game.ts.
- Split NetworkOptimizer.ts (727 → 3 files).
- Replaced NetworkOptimizer's strategy with **Steiner topology + graph colouring** (`37bb247 feat: Replace NetworkOptimizer with Steiner + graph coloring`).
- Extracted VisibilityManager and GameToolManager from Game.ts.
- Archived the MCP server (now under `mcp-server/README.md` only).
- Removed `TrafficPointEntity.ts` (264 lines dead parallel abstraction).

## Sources

- Project [`docs/MVP_ARCHITECTURE.md`](../../../../projects/trafficGame/docs/MVP_ARCHITECTURE.md) (canonical MVP layout).
- Project [`docs/LEARNINGS.md`](../../../../projects/trafficGame/docs/LEARNINGS.md) §"Refactoring Log (Feb 2026 Session)" + §"Session 2 refactoring".
- Recent git log on `projects/trafficGame/` — extractions and Steiner replacement.

## Related

- [`traffic-physics-and-flow`](traffic-physics-and-flow.md) — IDM, BPR, calibration.
- [`campaign-mode-state`](campaign-mode-state.md) — current 3-node `CampaignGraph` (the 9-level `CampaignLevels.ts` array was deleted).
- [`traffic-location-data-model`](traffic-location-data-model.md) — entry/exit point shape.
- [`ui-canvas-overlay-pattern`](ui-canvas-overlay-pattern.md) — UI/menu rendering.
- [`test-stack-and-gates`](test-stack-and-gates.md) — Vitest + Playwright discipline.
