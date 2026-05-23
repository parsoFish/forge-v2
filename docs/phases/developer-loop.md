# Phase: Developer Loop

> *Unattended.* Ralph loop pattern over Claude Agent SDK. Iterates per work item until quality gates pass.

## Purpose

Take a work item and drive it to "complete" (quality gates pass + acceptance criteria met) via the Ralph loop pattern. Multiple developer loops run in parallel across worktrees, coordinated by the scheduler.

## Inputs

- `<worktree>/.forge/work-items/<work-item-id>.md` (the work item spec from the PM).
- `loops/ralph/PROMPT.md.tmpl` (template stamped per work item).
- `loops/ralph/AGENT.md.tmpl` (institutional memory template; per-worktree state).
- Brain knowledge (queried at iteration 1 and on demand).

## Outputs

- Commits in the worktree (atomic per acceptance criterion where possible).
- `<worktree>/.forge/work-items/<work-item-id>.md` — frontmatter `status` updated to `complete` or `failed`.
- `<worktree>/AGENT.md` — final institutional memory (what was tried, what worked, what was learned for next time).
- Iteration events in `_logs/<cycle-id>/events.jsonl`.

## Skills

- [`skills/developer-ralph/SKILL.md`](../../skills/developer-ralph/SKILL.md) — the entry point that the orchestrator's `cycle.ts` invokes.

## Loop runtime

- [`loops/ralph/runner.ts`](../../loops/ralph/runner.ts) — driver.
- [`loops/ralph/stop-conditions.ts`](../../loops/ralph/stop-conditions.ts) — quality-gates-pass | iteration-budget | wedged-detector.
- [`loops/_adapters/`](../../loops/_adapters/) — placeholders for hermes/aider/openhands as alternative loop runtimes.

## Success signals

- **Iterations to green:** median iterations per work item ≤ 3 (lower is better).
- **Cost per work item:** ≤ $0.50 (target; surfaced via metrics).
- **Quality gate pass rate:** ≥ 95% on first acceptance-criterion verification.
- **Wedge rate:** ≤ 5% of work items hit `iteration_budget` without completing.
- **Merge success:** initiative-branch quality gates pass after all work items merge.

## Benchmark suite

[`benchmarks/developer-loop/`](../../benchmarks/developer-loop/) — five fixtures, one per managed project.
- `fixtures/<id>/` — seed worktree (source files + tests) plus `.forge/work-items/WI-1.md` (the WI spec) plus a failing acceptance test.
- `cases.json` — catalogue with per-fixture `quality_gate_cmd` + `pre_existing_tests_cmd` + budgets.
- `scoring.ts` — pure rubric (gate `terminated_cleanly`; weighted criteria for `loop_completed`, `iteration_budget_respected`, `cost_budget_respected`, `files_in_scope_respected`, `no_regression`; pass threshold 0.7).
- `sdk.ts` — per-fixture tempdir + runDevLoop entrypoint (shared with the live cycle via `orchestrator/dev-invocation.ts`).
- `score.ts` — runs the Ralph loop against each fixture, scores, writes `results/<iso>.json`.

## Known failure modes (to defend against)

- **Wedged loops** — Ralph never converges. `stop-conditions.ts` includes a wedged-detector (no progress for N iterations → abort).
- **Token burn on no-op iterations** — iteration budget caps this; cost budget per initiative caps it harder.
- **Hallucinated test passes** — quality gate verification runs in the orchestrator, not the agent (carried-over v1 lesson).
- **Merge conflicts across parallel loops** — handled by per-work-item branches off the initiative branch + orchestrator-level rebase before declaring a feature complete.

## TODO (post-scaffold)

- [x] Wire the Claude Agent SDK in `runner.ts` past skeleton — done via [`loops/ralph/claude-agent.ts`](../../loops/ralph/claude-agent.ts) (`createClaudeAgent` factory). The runner's `AgentInvocation` parameter accepts either the stub (default, for tests) or the SDK-backed agent.
- [x] Implement wedged-detector (no-progress heuristic) — done in [`loops/ralph/stop-conditions.ts`](../../loops/ralph/stop-conditions.ts) (default 3 iterations no-progress).
- [x] Implement quality-gates-pass stop condition with per-fixture commands — done. `LoopInput.qualityGate` is now injectable; the bench harness wires per-fixture commands (pytest / bats / node:test / grep). Live cycle still defaults to `npm test --silent` until per-project quality-gate config lands.
- [x] Per-iteration commit discipline + JSONL event emission — done. `orchestrator/cycle.ts:runDeveloperLoop` walks WIs in topological order, emits `ralph.start` / `ralph.end` per WI plus a phase-level summary.
- [x] Populate `benchmarks/developer-loop/fixtures/` with reference fixtures — five fixtures landed, one per managed project (env-optimiser, trafficGame, simplarr, GitWeave, healarr). Catalogue in [`benchmarks/developer-loop/cases.json`](../../benchmarks/developer-loop/cases.json).

## Onboarding a project

> Source of truth: [CONTRACTS.md C1 / C2 / C26 / C28](../planning/2026-05-20-refinement/CONTRACTS.md).
> Schema: [`docs/schemas/project-config.schema.json`](../schemas/project-config.schema.json).

Each managed project declares how forge should drive its dev-loop unifier
sub-phase via `<project-root>/.forge/project.json`. The file is **required**
to schedule any initiative against that project (fail-closed per council 04
F8); the scheduler refuses to dispatch an initiative whose project config is
missing or malformed, and surfaces the error in the operator queue.

### Checklist for a new project

1. **Create `<project-root>/.forge/project.json`** with at minimum a `demo`
   block (with a valid `shape`) and a `quality_gate_cmd` argv. See worked
   examples below per `demo.shape`.
2. **Verify `quality_gate_cmd` exits 0 on `main`** before any forge work
   begins. If it doesn't, the unifier's `initiative_gate` can never pass.
3. **For `shape: "browser"`:** add `preview_command`. Confirm Playwright
   (or your e2e runner) is installable locally. Forge picks a free port
   and passes it via env to the preview server.
4. **For `shape: "harness"`:** confirm `demo.command` completes within
   ~5 minutes on baseline and emits stable, regex-scrapable lines.
5. **Seed at least one brain theme** under
   `brain/projects/<project>/themes/` describing the project's
   demo-shape choice (see
   [`brain/projects/terraform-provider-betterado/themes/2026-05-18-go-test-harness-demos.md`](../../brain/projects/terraform-provider-betterado/themes/2026-05-18-go-test-harness-demos.md)
   for an example).

### Worked examples per `demo.shape`

Reference templates live under
[`docs/schemas/examples/`](../schemas/examples/) — operators run `cp` to
install the appropriate one and edit the project-specific commands.

| Project | `demo.shape` | Example |
|---|---|---|
| trafficGame | `browser` | [`project.trafficGame.json`](../schemas/examples/project.trafficGame.json) |
| terraform-provider-betterado | `harness` | [`project.betterado.json`](../schemas/examples/project.betterado.json) |
| slugifier | `artifact` | [`project.slugifier.json`](../schemas/examples/project.slugifier.json) |
| simplarr | `cli-diff` | [`project.simplarr.json`](../schemas/examples/project.simplarr.json) |
| healarr | `cli-diff` | [`project.healarr.json`](../schemas/examples/project.healarr.json) |
| env-optimiser | `artifact` | [`project.env-optimiser.json`](../schemas/examples/project.env-optimiser.json) |

### Failure-mode table (unifier sub-phase)

| Failure class | Trigger | Operator response |
|---|---|---|
| `dev-loop-unifier-gate-failed` | `initiative_gate` fails on branch tip | Inspect WIs that touched the failing area; consider PM re-plan |
| `dev-loop-unifier-demo-failed` | `demo_runs_clean` fails OR `pr_self_contained` fails | Check `.forge/project.json` `demo.command`; verify `preview_command` for `shape: "browser"` |
| `dev-loop-unifier-branch-divergence` | `assertLocalRemoteSynced` throws at unifier close | Resolve manually; remote moved during the cycle |

### Unifier sub-phase (S4)

After the last per-WI Ralph completes, the developer-loop invokes one more
Ralph — the **unifier** — with a distinct brief:

> Treat the initiative as one PR. Prove every AC against branch tip.
> Author the demo. Author the PR body. Refactor incidentally if it unifies
> the change. Do NOT add scope.

The unifier owns:

- `<worktree>/demo/<initiative-id>/` (tracked, born committed; no
  `.forge/demos/` shadow).
- `<worktree>/demo/<initiative-id>/DEMO.md` (relative-link images for
  visibility-agnostic rendering).
- `<worktree>/.forge/pr-description.md` (PR body, ≥ 300 chars with a
  `## Demo` section).
- A closing commit `feat(<initiative-id>): unify and demo` if any changes.

Iteration cap: **3** (no $ cap per CONTRACTS.md C19). Composed gates that
must all pass for the unifier to exit clean: `initiative_gate`,
`demo_runs_clean`, `pr_self_contained`, `branches_in_sync`.

In send-back mode (after a `/forge-review` nudge that produced
`pr-feedback.md`), the unifier accepts `--feedback-ref <path>` per
CONTRACTS.md C3b — it reads the C3a-shape feedback file and addresses each
comment by file/line without expanding scope.
