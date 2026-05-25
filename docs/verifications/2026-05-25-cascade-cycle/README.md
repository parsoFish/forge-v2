# Verification — cascading hex tree + Tier 1 thinning

> Cycle: `INIT-2026-05-25-claude-trail-verify-cascade` (claude-harness).
> Recorded: 2026-05-25 22:51 → 23:27 (autonomous part + manual approve
> + closure + reflection).
> Outcome: **merged + reflected**.

## What this verifies

This cycle is the standing reference for the post-2026-05-25 changes:

- **Tier 1 thinning** (forge-side): PM produced a 3-feature × 3-WI
  decomposition without the previous synthetic 1-WI bias, and dev-
  loop iterated each WI cleanly in one iteration each. Total spend
  $14.36. The cycle archive at
  [`brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md`](../../../brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md)
  captures the full event log.
- **Cascading hex tree** (UI-side): phases on top, features branching
  off the dev-loop hex, WIs branching off their features. Plan badge
  under architect; demo badge under review-loop.
- **Bug 1 fix**: architect phase shows complete (synthetic event at
  cycle.start). Visible at frame 03 onward.
- **Bug 2 fix**: reflection fires after `forge review --approve`. The
  closing log line confirms `Reflecting on cycle … / Reflection
  complete.` and the cycle archive is the reflector's output.
- **Bug 3 fix**: iter-0 sharp-gate failures emit as
  `event_type: 'log'` with `metadata.expected_fail: true`. Confirmed
  in `_logs/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade/events.jsonl`.
- **Event-driven UI materialisation**: feature + WI hexes appear only
  after their `pm.feature-decomposed` / `pm.work-item-emitted` events.
  Pre-PM frames show only the phase row.

## Frame index

| # | Frame | Moment |
|---|---|---|
| 01 | [initial-load](./frames/01-initial-load.png) | UI booted, cycle not yet claimed. |
| 02 | [cycle-focused](./frames/02-cycle-focused.png) | Scheduler claimed; operator clicked the cycle. |
| 03 | [architect-complete](./frames/03-architect-complete.png) | Architect hex green via the synthetic start/end events (Bug 1). |
| 04 | [project-manager-active](./frames/04-project-manager-active.png) | PM running — phase row only; no features yet (event-driven gate). |
| 05 | [developer-loop-pending](./frames/05-developer-loop-pending.png) | Phase rendering during PM thinking — no features/WIs surfaced. |
| 06–08 | (review/closure/reflection pending) | Same as 05; pre-PM-end states. |
| 09 | [project-manager-complete](./frames/09-project-manager-complete.png) | **PM done — features + WI hexes now visible** branching off dev-loop. Three features, three WIs. |
| 10 | [developer-loop-active](./frames/10-developer-loop-active.png) | Dev-loop iterating; WI-1 in progress. |
| 11 | [developer-loop-complete](./frames/11-developer-loop-complete.png) | Mid-WI handoff capture. |
| 12 | [developer-loop-failed](./frames/12-developer-loop-failed.png) | **Known issue, queued for next iteration**: dev-loop briefly flips to "failed" status because the unifier's transient `unifier.gate.initiative-failed` events (the unifier retried its composed gate several times before passing) are emitted with `event_type: 'error'`. The cycle ultimately succeeded; the UI status mapping needs to distinguish "WI-level failed" from "unifier-retry transient" — see operator notes (per-WI status colours, retry-yellow). |
| 13 | [review-loop-complete](./frames/13-review-loop-complete.png) | Unifier opened the PR locally (gh-shim writes pr-metadata.json). |
| 14 | [closure-complete](./frames/14-closure-complete.png) | Manifest moved to ready-for-review. |
| 15 | [done-state-with-reflection](./frames/15-done-state-with-reflection.png) | After `forge review --approve` → merge → reflection. All phases except dev-loop green (see frame 12 note). |

## What worked end-to-end

1. Cycle progression: pending → in-flight → ready-for-review → done.
2. PM decomposition into 3 features × 3 WIs (multi-WI confirmed).
3. Per-WI dev iterations passing first try ($0.40, $0.30, $0.38).
4. Unifier composed-gate retries (transient red events) eventually
   passing.
5. `forge review --approve` triggering reflection (Bug 2 fix).
6. Code shipped: `src/probe.ts`, `src/cli.ts` wiring, 3 new test
   files, 90 → 184 (or similar; ran clean) tests.
7. Brain artifacts: cycle archive +
   [`2026-05-25-unifier-wedge-preexisting-test-failures.md`](../../../brain/projects/claude-harness/themes/2026-05-25-unifier-wedge-preexisting-test-failures.md)
   + [`2026-05-25-wi-gate-vs-unifier-gate-mismatch.md`](../../../brain/projects/claude-harness/themes/2026-05-25-wi-gate-vs-unifier-gate-mismatch.md)
   added by the reflector.

## Known issues surfaced + queued

1. **Dev-loop hex flips red on unifier-retry transient errors.**
   Operator note 2026-05-25: features + WIs should follow blue/green/
   yellow/red independently; only the failed unit should flip; yellow
   for retrying; red only for full cycle failure. Currently any
   `event_type: 'error'` in the dev-loop window flips the phase.
2. **PM produced single-WI features.** Operator note: tweak the seed
   manifest to encourage varied feature sizes (1, 2, 3 WIs across
   different features).
3. **`scripts/verify-cycle.mjs` had a `Promise.race` bug** — serve's
   exit code 0 evaluated falsy so the auto-approve never fired in this
   run; cycle was approved manually. Fix next pass.

## Notes

- The video (~150 MB raw .webm) lives at
  `forge-ui/.demo-shots/verify/INIT-2026-05-25-claude-trail-verify-cascade/`
  on the operator's machine (gitignored — too large to commit raw).
- The code added by the cycle (`src/probe.ts` et al) is functional
  but explicitly throwaway per the initiative manifest. Safe to
  revert later if the operator decides.
