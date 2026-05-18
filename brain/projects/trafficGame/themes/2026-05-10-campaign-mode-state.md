---
title: trafficGame — campaign is a connected CampaignGraph (5-map directed convergent-AND world)
description: The level array is long gone. The campaign is a CampaignGraph of 5 maps with DIRECTED edges carrying real, count-parity-validated connection points. Unlock is convergent-AND (a map unlocks only when EVERY map feeding it is completed; sources always unlocked). The hub renders a spatial map-of-maps with two-way-road exit/entry ports. This is what any campaign/world/unlock initiative starts from now.
category: snapshot
keywords: [trafficgame, campaign, campaigngraph, campaignGraphData, worldedge, unlock, isUnlocked, convergent-and, connection-points, count-parity, MapLocationRegistry, gridPos, world-map, two-way-road, modular-maps, cross-map-flow]
created_at: 2026-05-10T15:30:00Z
updated_at: 2026-05-18T00:00:00Z
related_themes: []
---

# trafficGame — campaign is a connected `CampaignGraph`

> **History (do not regress to these):** there was once a linear 9-level
> `CampaignLevels.ts` array (under `src/campaign/`) — **deleted** (commit
> `9b5165b`); the file no longer exists.
> It was then a 3-node linear `CampaignGraph` with blank connection points
> and a brief "any neighbour solved" unlock rule. **Both are gone.** PR #54
> (merged 2026-05-18, origin/main `386e973`) replaced them with the model
> below. Plan against THIS; the older theme versions were the exact
> brain-staleness that thrashed a PM (see forge antipattern
> `stale-brain-contradicts-code-pm-failure`).

## As-built (post PR #54)

`src/campaign/campaignGraphData.ts` builds `CAMPAIGN_GRAPH = new
CampaignGraph(NODES, EDGES, MAP_LOCATION_REGISTRY)`.

**5 nodes**, each with a `gridPos {col,row}` (spatial layout, no
scoring/unlock effect): `crossroads (0,1)`, `straight-highway (1,2)`,
`four-way-hub (1,1)`, `crossing-flows (1,0)`, `one-per-edge (2,1)` — a
plus shape. (L-Shape / Merge-Point were dropped: their multi-point sides
had no count-matched partner.)

**4 directed `WorldEdge`s**, every one connecting two sides with the SAME
connection-point count (all 1↔1 here):
`crossroads.right→four-way-hub.left`,
`straight-highway.top→four-way-hub.bottom`,
`four-way-hub.top→crossing-flows.bottom`,
`four-way-hub.right→one-per-edge.left`. So `four-way-hub` is a
**convergent** node fed by both crossroads and straight-highway.

**Connection-point validation is wired into the PRODUCTION graph** (no
longer opt-in). `MAP_LOCATION_REGISTRY` is derived from
`src/traffic/MapDefinitions.ts` (single source of truth: mapId → side →
point count). The `CampaignGraph` constructor throws
`WorldEdgeValidationError` if an edge's side doesn't exist OR the two
connected sides' counts differ (cannot wire a 1-lane side to a 2-lane
side).

**Unlock = directed convergent-AND** (`CampaignGraph.isUnlocked`): a node
is unlocked iff it has no incoming edges (a SOURCE — always-unlocked
starting map: `crossroads`, `straight-highway`) OR **every** map that
feeds it is completed (`stars >= 1`). A node fed by several maps unlocks
only when ALL feeders are done. (`feedersOf()` is directed; `neighbours()`
is undirected, for display only.) "Solved" criterion unchanged: `stars>=1`.

**Hub UX** (`src/ui/CampaignHub.ts`): a spatial map-of-maps — tiles placed
by `gridPos`, directly connected (abutting). Every connection renders as a
**two-way road**: each connected side of each map shows BOTH an exit and
an entry (two lanes), mating with the connected map across the border.
Vector padlock for locked tiles (emoji renders as tofu under headless
capture). Lock state from `unlockedNodeIds()`. `src/main.ts` only imports
the `CampaignNode` type — data/unlock changes flow into the hub
automatically; do NOT wire main.ts.

## Not built / future direction (do not pick up without an initiative)

- **Cross-map traffic flow.** The two-way roads are the *physical*
  connection prepared for future "spawn points on some maps, traffic flows
  to connected maps via the routes" — explicitly NOT implemented; the per-
  map sim still spawns its own vehicles. Progression is still directed.
- **Modular/derived map generation.** The reviewer suggested generating
  maps modularly from neighbouring maps so connection points line up by
  construction (vs the curated count-matched set). Acknowledged as a
  direction; not built.
- Scoring is single-source-of-truth and untouched by all of the above
  (`UnifiedScore` / `WorldSimulator` / `starThresholds` / `targetGrade`).

## Sources

- [`src/campaign/campaignGraphData.ts`](../../../../projects/trafficGame/src/campaign/campaignGraphData.ts) — NODES/EDGES + MAP_LOCATION_REGISTRY.
- [`src/campaign/CampaignGraph.ts`](../../../../projects/trafficGame/src/campaign/CampaignGraph.ts) — `isUnlocked` (convergent-AND), `feedersOf`, count-parity validation.
- [`src/ui/CampaignHub.ts`](../../../../projects/trafficGame/src/ui/CampaignHub.ts) — spatial map-of-maps, two-way-road ports.
- [`src/traffic/MapDefinitions.ts`](../../../../projects/trafficGame/src/traffic/MapDefinitions.ts) — per-side connection-point counts (registry source).
- Git: origin/main `386e973` (PR #54 merge). Tests: `tests/campaign/CampaignGraph.test.ts` + `campaignGraphData.test.ts` (convergent-AND, count-parity, no-phantom).

## Related

- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — src/ tree.
- [`per-map-calibrated-thresholds`](per-map-calibrated-thresholds.md) — scoring tuning (out of scope here).
- [`algorithm-heavy-items`](algorithm-heavy-items.md) — decomposition discipline.
