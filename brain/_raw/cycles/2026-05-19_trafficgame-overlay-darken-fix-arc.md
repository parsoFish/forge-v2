# 2026-05-19 — trafficGame overlay-darken fix arc (PR #56)

Cycle archive for the trafficGame overlay-clear-fix initiative
(`INIT-2026-05-18-trafficgame-overlay-clear-fix`, PR #56) and its
sibling forge-process and backpressure work that landed in the same
period. Honest as-built: what was true at close, including the
detours and what stayed open.

## Outcomes (closed)

- **PR #56 merged** to trafficGame `main` (`59d1713`, 2026-05-19T21:45Z).
  Cumulative-darken bug in the pause menu is fixed; merged tree passes
  869 unit tests (3 pre-existing skipped). Local main fast-forwarded;
  remote + local feature branch deleted; worktree removed; queue
  manifest moved `ready-for-review/ → done/`.
- **PR #55 merged earlier in the arc** (`e3b1da1`) — backpressure
  foundation FEAT-1/2 (getBackpressure accessor + virtual stop-line
  IDM deceleration).
- **`INIT-2026-05-19-trafficgame-backpressure-live`** queued (the
  remaining FEAT-3 wiring + FEAT-4 anti-collision invariant on top of
  #55), running autonomously on the fixed daemon.

## Root causes found (and what landed for each)

### 1. Overlay cumulative darkening — three-iteration detour

The bug only made sense once the architecture was admitted: ONE shared
`<canvas>` for the whole app; opening an overlay calls
`currentGame.stop()` (cancels rAF, paused game), so nothing repaints
behind the overlay. That paused-shared-canvas property rules out the
two naive fixes:

- **Iteration 1 — `clearRect`-less `fillRect` (the original bug):**
  every hover stacks another `rgba(0,0,0,0.7)` layer → 70% → 91% →
  97% → black.
- **Iteration 2 (dev-loop):** routed `onMouseMove → this.redraw()`
  (clear+draw). Stopped the stacking, but `clearRect` erased the
  paused game frame and nothing repainted it → menu on blank/black
  ("doesn't appear to have fixed this").
- **Iteration 3 (landed, `01630c7`):** `CanvasScreen.start()`
  snapshots the canvas via `getImageData`; `redraw()` does
  `clearRect → putImageData(backdrop) → draw()`. Single dim, every
  time, over the SAME captured game frame. Degrades to plain clear if
  `getImageData` throws (tainted canvas). SandboxSettingsPanel also
  refactored to extend CanvasScreen so the fix applies uniformly.

Verification trust-rebuild: jsdom unit tests had been passing for the
broken iteration 2 because jsdom's `getImageData` throws → graceful-
degrade hides the regression. The honest verification was an actual
Playwright + measured-luminance run in a real browser on the Crossroads
map: opening the menu drops luminance 43.93 → 17.43 (dim correctly
applied); 12 hover cycles hold it at **constant 17.43, net 0 darkening**;
screenshot shows the game stably dimmed behind the panel.

Brain theme refreshed: `brain/projects/trafficGame/themes/2026-05-10-ui-canvas-overlay-pattern.md`
(now category `pattern`, indexed in `patterns.md`).

### 2. forge process — fixed-path scratch caused cross-initiative add/add conflicts

The reviewer-Ralph prompt (`orchestrator/reviewer-invocation.ts:87,184`)
instructed the agent to `Commit demo + PR-description` — committing
`.forge/pr-description.md`, a **gitignored, fixed-path** scratch file.
Two parallel initiatives both commit that path → guaranteed `add/add`
conflict on the second PR once the first merges (#55 merged → #56
conflicted).

Landed fix in `orchestrator/`:
- Prompt edits in `reviewer-invocation.ts` removing the `.forge/`
  commit instruction; explicit "do not `git add` `.forge/`" guidance.
- Enforced `pr.ts:stripForgeScratchFromBranch` called in both
  `pushInitiativeBranch` and `openPullRequest` — strips any tracked
  `.forge/` from the index and commits the removal before every push,
  so scratch can never reach origin regardless of agent behavior.
  Defense-in-depth.
- Immediate cleanup on #56: merged main, untracked `.forge/`, pushed;
  the resulting merge into main self-cleaned the stray
  `.forge/pr-description.md` #55 had wrongly added on main.

Forge tests: **511 green**, build clean.

### 3. Backpressure-wiring follow-up — branched from stale local `main`

`INIT-2026-05-19-trafficgame-backpressure-wiring` had
`depends_on_initiatives: [#55-id]`. The scheduler gated correctly on
the dependency's manifest being in `_queue/done/` after I reconciled
#55's merge. But forge does **not** fast-forward the project's local
`main` to the merged `origin/main` before
`git worktree add`. Local `main` was stale at `#54` (`386e973`,
pre-`#55`). The dependent worktree was cut from the stale base and
the dev-loop **re-implemented FEAT-1/2** (re-added `getBackpressure`,
extended `updateVehicleSpeed`) on top of the pre-#55 commit. Result:
the branch had 3 conflicting paths against the now-#55-merged main
(`src/traffic/CarFollowing.ts`, `src/traffic/RoadSegmentMetrics.ts`,
`tests/traffic/RoadSegmentMetrics.test.ts`) and was unmergeable. The
reviewer phase also crashed transiently
(`Claude Code process exited with code 1`), unclassified.

Resolution: synced local `main` → `e3b1da1`; abandoned the redundant
branch + failed manifest; re-queued
`INIT-2026-05-19-trafficgame-backpressure-live` (terse, just the
FEAT-3 sim wiring + FEAT-4 invariant, on the correct #55-merged base,
no inter-initiative dependency since FEAT-1/2 are now in main).

## Deferred (NOT fixed in this arc — see memory `project_forge_deferred_defects`)

Two systemic forge defects surfaced during the arc and were explicitly
deferred by the operator ("save b and c to change after"):

- **(b) Reviewer transient SDK crash is unclassified + strands work.**
  Same `Claude Code process exited with code 1` seen on WI-2 of #55
  and the entire review phase of backpressure-wiring. The
  failure-classifier marks it `unknown / not recoverable`; the cycle
  goes to `_queue/failed/` and a completed dev-loop's work is
  stranded on the branch with no PR. Suggested direction: classify
  the signature as recoverable → auto-retry just the review (the dev
  work is already committed), or auto-create the PR from the pushed
  branch.
- **(c) Dependent initiatives branch from stale local `main`.**
  `scheduler.checkInitiativeDeps` only gates on
  `_queue/done/` — never fast-forwards local `main` to
  `origin/main` before `git worktree add`. Wire `alignLocalToRemote`
  (already implemented for closure) into the worktree-creation path
  for dependents.

## Trust + verification lesson

This arc had multiple "looks fixed from code analysis / unit tests"
that the operator empirically falsified ("no faith in your testing").
The corrective discipline that finally worked: a real-browser
Playwright run that *measured pixel luminance* on the actual menu in
the actual game, plus a screenshot. jsdom unit tests passed for the
broken iteration 2 because the jsdom canvas's `getImageData` throws,
which exercised only the graceful-degrade path — hiding the
regression that the operator saw in the browser. Reusable rule:
**for visual/canvas correctness, the only honest gate is a real
browser + measured pixels** (or a properly-rendered screenshot). The
project's existing visual gate (`tests/e2e/`) was red for unrelated
reasons (campaign rewrite stale assertions on node 0 = "Straight
Highway" vs current "Crossroads") — worth a separate cleanup
initiative.

## Open follow-ups

- `INIT-2026-05-19-trafficgame-backpressure-live` (running):
  FEAT-3 (`VehicleSimulation` backpressure wiring on top of merged
  #55) + FEAT-4 (anti-collision invariant + jam-clears proof).
- `tests/e2e/{campaign-graph,graph-progression,play-node}.spec.ts`
  reds the project's visual gate — stale campaign assertions from
  #54/#55 rewrite (node 0 is now Crossroads, not Straight Highway).
- Forge defects (b) and (c) deferred to a later operator session.

## Sources

- PR #56 merge: `59d1713` (main); fix commit `01630c7`.
- PR #55 merge: `e3b1da1`.
- Manifests: `_queue/done/INIT-2026-05-18-trafficgame-{overlay-clear-fix,intersection-backpressure}.md`.
- Forge changes (uncommitted in working tree at close): `orchestrator/pr.ts`
  (`stripForgeScratchFromBranch`), `orchestrator/reviewer-invocation.ts`
  (prompt fix), plus earlier P2/P3/P4 work.
- Operator memories pairing with this arc:
  [[pr-comment-review-loop]], [[driving-full-forge-cycle]],
  [[forge-deferred-defects]] (new — b/c).
