# Cycle archive — trafficGame world-map review arc (2026-05-17 → 2026-05-18)

**Type:** operator-driven review arc (not a single runCycle — manual
architect/dev/review by the agent acting as operator, then merged by the
human on GitHub).
**Outcome:** trafficGame PR #54 MERGED (origin/main `386e973`). Forge
hardening on local branch `fix/operator-review-reliability` (awaiting
operator review; forge has no remote).

## What landed (trafficGame)

Connected `CampaignGraph` world replacing the linear/3-node demonstrator:

- 5 maps with `gridPos` spatial layout (plus shape around `four-way-hub`).
- 4 **directed** `WorldEdge`s; every edge connects two sides with the
  SAME connection-point count. Validation derived from `MapDefinitions`
  and **wired into the production graph** (was opt-in) — invalid edges
  throw.
- Unlock = **directed convergent-AND**: source maps always unlocked; a map
  unlocks only when EVERY map feeding it is completed. `four-way-hub` is
  the convergent demonstrator (fed by crossroads + straight-highway).
- Hub UX: spatial map-of-maps; every connection a **two-way road** —
  each connected side shows both an exit and an entry, mating across the
  shared border. Vector padlock (emoji → tofu under headless capture).
- Scoring / `WorldSimulator` / `main.ts` byte-unchanged. 837 tests pass.

## Review shape (the interesting part)

Four review rounds, entirely on **PR #54's comment thread**: cardinality
parity → no-phantom-connections → convergent-AND unlock → both-in-and-out
per side → two-way-road. Each round: operator comment → agent addresses →
push → re-review on the PR. The demo was committed into the branch
(`demo/world-map/`) so the PR was self-contained. This loop was tighter
and higher-fidelity than the file-verdict send-back loop.

## Forge findings (hardened)

From the earlier post-mortem + this arc:

1. `alignLocalToRemote` stranded the operator's working tree (ref moved,
   no checkout) → now ff's the project tree, stash-preserving operator
   state. **#1 reason the operator couldn't review.**
2. `node_modules` symlink (forge's `linkProjectDeps`) was committed to
   main (`.gitignore node_modules/` doesn't match a symlink) → worktree
   git-exclude + boundary-commit guard + `.gitignore` tightened.
3. Reviewer per-iteration $/turn budget guards were too tight (0 verdicts,
   never reached the gate) → removed entirely (operator decision).
4. Demo capture latched a stray dev server → demo-runtime prefers built
   `preview`; reviewer prompt mandates isolated strict-port server.
5. Brain staleness silently thrashed the PM → preflight BRAIN WARN +
   `pm-thrash-no-converge` classifier (not auto-retried).
6. `pr-as-sole-review-window`: demo committed into the PR;
   **visibility-aware** (private repo → relative-link DEMO.md, not inline
   raw — GitHub's image proxy can't fetch private raw).

## Brain maintenance

`campaign-mode-state` rewritten to the as-built model. It had gone stale
**twice** during this arc — the exact failure mode hardened in finding 5.
Keeping it current is the reflection's load-bearing act; verified the
brain index/lint stays clean.

## Carried as themes

- `brain/projects/trafficGame/themes/2026-05-10-campaign-mode-state.md` (rewritten).
- `brain/forge/themes/pr-as-sole-review-window.md` (new pattern; indexed).
- `brain/forge/themes/stale-brain-contradicts-code-pm-failure.md` (prior arc; reinforced).

## Note: brain-staleness guard validated (with a known limitation)

The new `forge preflight` BRAIN check (added this arc) fired correctly on
`campaign-mode-state` and is now clean after the rewrite. Known coarse
false-positive: a theme that *documents a deletion* must name the deleted
path, which the path-existence heuristic flags. Mitigation for now: phrase
deleted-file references without a `src/…`/`tests/…`-shaped token (prose or
bare basename). A context-aware refinement (ignore tokens in "deleted/no
longer/history" lines) is a possible future forge improvement — left as a
note, not built (advisory WARN, not blocking).
