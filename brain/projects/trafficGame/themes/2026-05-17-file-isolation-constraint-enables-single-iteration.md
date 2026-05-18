---
title: trafficGame — one-file-per-WI constraint correlated with single-iteration dev-loop success
description: Manifest hard constraints (FEAT-1 → campaignGraphData.ts, FEAT-2 → CampaignGraph.ts, FEAT-3 → CampaignHub.ts; no shared files across features) produced 3 dev-loop WIs that each completed in a single iteration with no wedge events, no send-backs, and 836 tests green. File-isolation avoids the file-collision failure mode seen in prior trafficGame cycles.
category: pattern
keywords: [trafficgame, file-isolation, manifest-constraints, single-iteration, one-file-per-wi, decomposition, developer-ralph]
created_at: 2026-05-17T14:30:00Z
updated_at: 2026-05-17T14:30:00Z
related_themes: []
---

# trafficGame — one-file-per-WI constraint correlated with single-iteration dev-loop success

## Observation

The manifest for `INIT-2026-05-17-world-graph-connectivity` included an explicit file-isolation hard constraint:

> **Edit ONLY these 3 production files** (plus their `tests/campaign/` specs). One file per feature — no shared files across features:
> - FEAT-1 → `src/campaign/campaignGraphData.ts`
> - FEAT-2 → `src/campaign/CampaignGraph.ts`
> - FEAT-3 → `src/ui/CampaignHub.ts`

Each of the 3 WIs completed in exactly 1 iteration. There were no wedge events, no quality-gate failures during iteration, and no send-backs from the review phase on the dev-loop work itself. Final test count: 836 passed / 3 skipped across 49 files.

## Why this works

trafficGame's prior file-collision failures occurred when two WIs claimed overlapping files (e.g. two WIs that both touch `CampaignHub.ts` or `CampaignGraph.ts`). With overlapping scope, the second WI applies changes on top of an intermediate state the first WI left, which frequently leads to merge artefacts, broken imports, or test failures that require additional iterations to resolve.

A one-file-per-WI constraint makes the dependency graph unambiguous: WI-N writes exactly its file, WI-(N+1) reads the output of WI-N and writes exactly its own file. No implicit merge is required.

## When to apply this pattern

- When the initiative naturally decomposes along a strict data-flow chain (data-shape → algorithm → rendering/UI).
- When each feature's surface is already bounded by a single module (the campaign layer in trafficGame is designed this way: data in `campaignGraphData.ts`, logic in `CampaignGraph.ts`, presentation in `CampaignHub.ts`).
- When the architect can specify the file assignment in the manifest's hard constraints before the PM sees it.

The constraint should be set **in the manifest**, not delegated to the PM's decomposition step, because the PM may choose different decomposition boundaries if unconstrained.

## Limitations

This pattern works best when the features map onto the existing module boundaries. It is not always achievable; but when it is, it is a strong predictor of low-iteration dev-loop runs.

## Sources

- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/events.jsonl` — WI-1, WI-2, WI-3 each show `iterations: 1`, `stop_reason: quality-gates-pass`, no wedge events.
- `_queue/done/INIT-2026-05-17-world-graph-connectivity.md` — hard constraints section specifying one file per feature.
- `/home/parso/forge/brain/_raw/cycles/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity.md` — cycle archive §"Finding 5".

## Related

- [`algorithm-heavy-items`](algorithm-heavy-items.md) — decomposition discipline for trafficGame; this pattern is its positive counterpart.
- [`developer-ralph-brain-skip-on-second-wi`](2026-05-10-developer-ralph-brain-skip-on-second-wi.md) — the brain-first skip antipattern; a WI completing in 1 iteration does not guarantee brain-first was honoured.
