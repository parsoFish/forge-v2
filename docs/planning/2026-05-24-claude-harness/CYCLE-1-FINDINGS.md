# Cycle 1 — findings before operator hand-off

> 5 attempts at running INIT-2026-05-24-claude-trail-scaffold through a
> full forge cycle. Got progressively further each attempt. Final
> attempt: dev-loop reached 6/6 WIs complete (was 0/6 at attempt 1);
> unifier wedged. Stopping to align with the operator before more
> retries.

## What worked

The harness functioned exactly as it's meant to — running a real
cycle against a tiny project surfaced 5 real forge defects that the
unit tests + benches missed:

| # | Defect | Why it bit | Fix | Commit |
|---|---|---|---|---|
| 1 | Gate hard-coded `git diff --name-only main...HEAD` | claude-harness's default branch was `master` (fresh `git init` default); diff silently empty → required-paths rejection for 5 iterations even though commits existed | `resolveBaseBranch` tries main → master | 23db87f |
| 2 | F1.I5 over-constrains modify-only WIs | WI-6 *modifies* src/trail.ts (created by WI-2); validator required it in `creates:`; operator note: "overly restrictive… would not allow agentic flexibility" | Removed F1.I5 + path-tightening; `quality_gate_cmd` is sole arbiter, `no-work-indicator` is the safety net | 23db87f |
| 3 | Agent sometimes forgets `git commit` | Sonnet/Opus drift past the system-prompt instruction; gate's diff stays empty → wedged | `autoCommitWorktreeIfDirty` runtime safety net (operator's note: should be a hook, not a runtime check — see follow-up below) | 23db87f |
| 4 | `pushInitiativeBranch` + `checkLocalRemoteSynced` assume `origin` exists | claude-harness has no GitHub remote; first WI completed, every subsequent WI cascade-skipped `branch-push-failed-early-exit` | Both functions short-circuit on no-origin (local IS the source of truth) | 36569d0 |
| 5 | ActivityPanel rendered metadata as raw JSON | Operator: "hard to discern from a single log"; per-iter `bash_commands` / `tools_used` / `last_assistant_text` / `gate_stderr_tail` were in events.jsonl but invisible | Detail pane surfaces each inline; raw JSON behind `<details>` toggle | 23db87f |

After fixes 1–4, cycle 5 ran:

```
PM started → PM ok → 6 WIs
WI-1 dev complete · $0.35 · iters=1 · quality-gates-pass
WI-2 dev complete · $0.38 · iters=1 · quality-gates-pass
WI-3 dev complete · $0.68 · iters=1 · quality-gates-pass
WI-4 dev complete · $0.69 · iters=2 · quality-gates-pass
WI-5 dev complete · $0.58 · iters=1 · quality-gates-pass
WI-6 dev complete · $0.26 · iters=1 · quality-gates-pass
                                  total: $2.94, 7 iters across 6 WIs
review started
unifier wedged at iter 2 — never wrote DEMO.md / .forge/pr-description.md
cycle ERROR: reviewer.pr-open-failed (correctly classified per F1.I1)
```

## What didn't (the open question)

Two issues remain, related to the operator's holistic git-ops + hooks
guidance:

### A. Production `gh` shim for no-origin projects

The bench already has [`benchmarks/_lib/gh-shim.ts`](../../../benchmarks/_lib/gh-shim.ts)
— a Node script that emulates `gh pr create / view / merge` against
local-only repos (writes `_pr-metadata.json`, fast-forwards local
main on merge). It's wired only into bench harnesses.

**Lift it to `orchestrator/gh-shim.ts`** and use it from `pr.ts`'s
`openPullRequest` / `prRef` / `confirmPrMerged` / `mergePullRequest`
when `hasOriginRemote(worktreePath) === false`. Matches operator's
intent: "essentially 'mocking' the git remote to avoid the challenges
of auth and potential network latency and issues causing negative
impacts to our forge development cycles for use in no remote git
repos."

Adjustments needed vs. the bench version:
- Branch validation: bench expects `initiative-<id>`, forge uses
  `forge/<initiative-id>`. Make the prefix configurable or accept
  both.
- Snapshot dir target: bench writes to its tempdir; production
  should write to `_logs/<cycleId>/_forge-snapshot/` (path-stable
  across the worktree's eventual cleanup).

This unblocks `openPullRequest` and `confirmPrMerged` on
claude-harness without code changes to either function — they just
exec `gh` and the shim intercepts.

### B. Unifier wedging — agent doing exploration instead of writing

Cycle 5 unifier transcript (per `[harness:S?]` per-iter events):

```
iter 1: bash[ls, git log, ls src/, ls tests/, ls tests/fixtures/] — 0 writes
        last text: "Now let me read the test files and the package.json:"
iter 2: bash[ls, git log, ls src/ tests/, git log, ls tests/fixtures/] — 0 writes
        last text: "Now let me look at the existing test files and the package.json:"
gate: `pr_self_contained` rejects — no DEMO.md, no .forge/pr-description.md
stop_reason: wedged
```

The unifier is **exploring**, not **producing**. Two iterations of
`ls + git log` followed by trailing-off ("Now let me look at…")
without ever writing the two required files. This is the same shape
as the original "agent forgets to commit" pattern from the dev-loop
(fix #3) — except here it's "agent forgets to *write the output*."

Per operator's principle ("these sort of things … should be solved in
deterministic ways"), the cleanest fix is **deterministic generation
of DEMO.md + pr-description.md as a hook** rather than agent-driven:

- `forge demo` already exists and renders a before/after demo
  bundle deterministically from git refs.
- pr-description.md can be assembled deterministically from
  `manifest.body` + WI ACs + cycle events (cost, iters, themes
  consulted).

Concretely: replace the unifier's agent invocation with a
deterministic generator that runs `forge demo` + assembles
pr-description from the same data the agent sees. The agent's role
becomes optional narrative addendum, not the load-bearing producer.

## Why I'm not pushing through round 6 blind

The two open issues are structural, not "one more prompt tweak". A
gh-shim build is meaningful — non-trivial — and the unifier-as-hook
question is a real architectural choice. Pushing through another LLM-
priced cycle without your call on either would be wasteful.

## What I need from you

1. **gh-shim** — confirm the lift-to-orchestrator approach + the
   forge/<id> branch-prefix adjustment. (Or push back: a different
   shape?)
2. **Unifier determinism** — ratify replacing the unifier agent with
   a deterministic generator (option I lean toward), OR direct me at
   a different fix (better prompt? more iters? hook on the agent's
   exit?).
3. **Architect interview** — separate ask from earlier; once cycle 1
   reaches green I'll run the real `/forge-architect claude-harness`
   so roadmap + council exist for cycle 2.

Pending your direction on (1) and (2), I'll either build them or
take the alternative path you point me at.
