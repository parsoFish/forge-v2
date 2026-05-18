---
title: trafficGame — stale brain themes that contradict the codebase cause PM-phase failure
description: Two 2026-05-10 themes still described the deleted CampaignLevels.ts array. The PM read the brain (8 reads), ingested a false model, Glob'd the real tree, hit an irreconcilable contradiction, and exhausted its entire budget producing hallucinated work items. Stale-but-contradictory brain content is worse than a gap.
category: antipattern
keywords: [trafficgame, stale-brain, brain-contradiction, pm-failure, campaignlevels, campaigngraph, by-hand-change, reflection-bypass, brain-accuracy]
created_at: 2026-05-17T14:30:00Z
updated_at: 2026-05-17T14:30:00Z
related_themes: []
---

# trafficGame — stale brain themes that contradict the codebase cause PM-phase failure

## What happened

The PM phase for `INIT-2026-05-17-world-graph-connectivity` failed **twice** (turn-cap, then cost-cap) in a prior attempt of the same initiative. The PM made 8 brain reads, loaded the `campaign-mode-state` and `mvp-architecture-snapshot` themes, and ingested a model that described a linear 9-level `CampaignLevels.ts` array. It then Glob'd the real source tree and found `CampaignGraph.ts`, `campaignGraphData.ts`, and no `CampaignLevels.ts`. The contradiction was irreconcilable. The PM burned its entire budget thrashing between the two models, producing work items describing hallucinated "verify/polish/navigation-service" tasks that implemented nothing.

Correcting the two themes to reflect the as-built `CampaignGraph` reality (done by the operator) fixed the issue immediately. The next PM run produced a clean 3-WI decomposition in 2m 10s.

## Root cause

The `CampaignGraph` migration landed **by hand, outside a forge reflection cycle**. No reflection was run, so the brain was never updated. The themes remained frozen at the state they described when they were written (the old level array). This is a specific failure mode distinct from a brain gap:

- **Gap**: the brain has no knowledge of X → the PM asks forge, gets `unknown`, proceeds cautiously.
- **Contradiction**: the brain asserts X, the code asserts not-X → the PM has two authoritative-seeming sources in direct conflict; it cannot recover autonomously.

Contradictions are worse than gaps.

## Mitigation

- **Forge-level**: add a staleness check that flags brain themes whose `## Sources` cite files that no longer exist (e.g. `CampaignLevels.ts` → deleted → flag the theme as stale).
- **Forge-level**: classify "brain-read vs Glob contradiction" as a first-class PM failure subtype with the recommendation "brain may be stale — reconcile against code" rather than the current generic `pm-hidden-coupling / add the missing edge` advice.
- **Operational**: any by-hand project change that bypasses forge must be followed immediately by a brain correction pass. The rule: if you change the code outside a cycle, update the brain.

## Sources

- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/events.jsonl` — PM events: 8 brain reads, pm.end with hallucinated WIs (prior run attempt described in user-feedback.md).
- `_logs/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity/user-feedback.md` — operator description of the failure and fix.
- `/home/parso/forge/brain/_raw/cycles/2026-05-17T13-36-43_INIT-2026-05-17-world-graph-connectivity.md` — cycle archive §"Finding 1".

## Related

- [`campaign-mode-state`](2026-05-10-campaign-mode-state.md) — one of the two themes that was stale (now corrected to as-built `CampaignGraph`).
- [`mvp-architecture-snapshot`](2026-05-10-mvp-architecture-snapshot.md) — the other stale theme (now corrected).
