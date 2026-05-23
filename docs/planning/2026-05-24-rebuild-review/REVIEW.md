---
doc: rebuild-review
date: 2026-05-24
trigger: operator close-of-session brief 2026-05-24 — "if you were to rebuild forge from scratch with all you know now"
authority: broad authority to simplify or remove components, guardrails, and complexity
status: synthesis draft — operator picks up next session
inputs:
  - codebase audit (subagent Explore — 47 tool uses, 88s)
  - web research on agent-flow + 6 other agentic-orchestrator projects + Anthropic SDK docs
  - 3-retry dogfood arc (INIT-01 betterado, 2026-05-23) — all 3 retries failed in different modes
---

# Forge rebuild-review — 2026-05-24

> **The operator's read is validated.** Forge is overcooked in specific,
> identifiable ways. A v3 rebuild would not look radically different at
> the phase level — the 6-phase decomposition, Ralph loop, file-based
> human moments, work-item schema, worktree isolation, and per-phase
> benchmarks are all earning their keep. What's overcooked is the
> **orchestrator surface**: it has accumulated ~3500-4500 LOC of
> centralised logic (cycle wiring, metrics, linting, classifier, demo,
> report) that a from-scratch design would distribute to separate
> processes or CLI utilities. The recent dogfood validated this by
> exposing 3 different failure modes in 3 retries, each hot-patched by
> adding logic to `orchestrator/` rather than to the phase that owns
> the concern.

## 1. The biggest unstated assumption (the load-bearing one to reconsider)

**Forge assumes the orchestrator must be the single coordinator of all
cross-cutting concerns** — cycle wiring, phase invocation, event
logging, brain reads/writes, queue state, PR/git operations, retry
logic, metrics, notifications, AND the CLI surface. This shows up as:

- 48 TypeScript files in `orchestrator/`, ~25K LOC, 684 import/export
  statements across the dir.
- Every new defect we hot-patch lands here because it's the path of
  least resistance.
- Three retries this session each added logic to the orchestrator:
  - **Retry 1** → gate-tightening in `loops/ralph/stop-conditions.ts` +
    `orchestrator/phases/developer-loop.ts` (`requiredPaths` check).
  - **Retry 2** → PM SKILL tightening (brain-query bound +
    hidden-coupling self-check).
  - **Retry 3** → `developer-loop.ts` early-exit on
    `dev-loop.branch-push-failed` + `orchestrator/cli.ts`
    `--abandon` remote-branch cleanup.

Convergent evidence from the public domain (`ruflo`, `ccswarm`,
`ralphinho-rfc-pipeline`, Anthropic's own multi-agent coordination
patterns) is that **separate-process per phase wins for production**.
Forge already runs each phase via the Agent SDK (separate process), so
the structural pattern is right — but the orchestrator wraps each
invocation in increasing layers of pre-flight + post-flight logic.

**The rebuild move:** thin the orchestrator to ~300 LOC (loop +
fanout), let phase runners be autonomous skills that handle their own
pre/post-flight, and move all non-orchestration concerns (metrics,
lint, demo, classifier) to CLI utilities outside the hot path.

## 2. What a v3 rebuild looks like (sketch)

```
forge-v3/
├── scheduler/                # ~300 LOC: loop + fanout, claim from pending, set up worktree
├── phases/                   # each is an autonomous skill — orchestrator doesn't choreograph
│   ├── architect/            # owns its own brain-query, council, PLAN emission
│   ├── pm/                   # owns its own brain-query (capped), WI validation, hidden-coupling check
│   ├── dev-loop/             # owns its own Ralph + gate + push
│   ├── unifier/              # owns PR + demo
│   ├── review/               # owns verdict routing
│   └── reflect/              # owns theme writes + cycle archive
├── daemon/                   # queue polling, worktrees, heartbeats, notifications
├── skills/                   # SKILL.md prompts (unchanged from today)
├── brain/                    # unchanged
├── shared-state/             # CCSwarm/Ruflo-style MessageBus for inter-phase coord
│                             # replaces file-based handoff for cycle-internal state
└── utils-cli/                # `forge metrics`, `forge lint`, `forge demo`, `forge watch` (TUI)
                              # all post-cycle, not phase internals
```

**Net surface area:** orchestrator drops from ~25K to ~3K LOC. Phases
own ~5K each. Daemon is ~1K. Total ~25K (similar) but **distributed**
— each phase can fail independently without bringing down the others
or spreading complexity to the orchestrator.

## 3. Specific cuts (codebase audit — top 10 by surface × confidence)

| # | Area | LOC | Reason | Action |
|---|---|---|---|---|
| 1 | `orchestrator/demo*.ts` | ~1300 | Not load-bearing; unifier's `pr-not-self-contained` gate already catches missing demo | Move to `forge demo` post-cycle CLI |
| 2 | `orchestrator/architect-plan.ts` | 1056 | Custom HTML-comment annotation parsing duplicates what `verdict.md` could do | Collapse to `verdict.md` + raw manifest write, ~150 LOC |
| 3 | `orchestrator/brain-lint.ts` | 902 | Scope vocabulary (cycle-touched-themes etc.) future-proof, not earning keep | Shrink to 200 LOC: frontmatter + orphan check only |
| 4 | `orchestrator/cycle-report.ts` | 736 | Markdown formatting duplicates `events.jsonl` | Replace with `forge metrics` jq wrapper |
| 5 | `orchestrator/preflight.ts` + `brain-bench-promote.ts` | 815 | Operator utilities, not phase concerns | Move to `forge preflight` / `forge admin:*` subcommands |
| 6 | `orchestrator/review-router.ts` | 446 | Async daemon polling future-proof; today operator manually runs `/forge-review` | Fold into `/forge-review` slash command |
| 7 | `orchestrator/metrics.ts` + `logging-pretty.ts` | ~450 | Same info already in events.jsonl | Move to `forge watch` TUI + jq |
| 8 | `orchestrator/failure-classifier.ts` | 250+ | 14 failure modes; only ~4 recoverable | Collapse to `transient` vs `terminal` |
| 9 | Quality-gate tightening (added today) | ~200 | Band-aid in `dev-invocation.ts` + `phases/developer-loop.ts` | Move verification to gate executor: check `creates` in diff BEFORE running gate cmd, single place |
| 10 | Graphify brain-graph mandate | (no LOC) | Brain-query passes benches at 94.4% without it | Keep hooks; drop mandate; let graphify mature as power-tool |

**Estimated total LOC reduction:** 3500–4500. Estimated test-suite
removal: 30-40% of bench harness (the non-rubric scaffolding).

## 4. What forge is right about (preserve in v3)

1. **Ralph loop abstraction** ([`loops/ralph/runner.ts`](../../../loops/ralph/runner.ts)) — generic iteration loop parameterised by quality gate, system prompt, and injectable agent adapter. Reused across dev-loop, unifier, and (future) reviewer. Legitimately elegant.
2. **File-based human moments** — `/forge-architect`, `/forge-review`, `/forge-reflect` using verdict files + feedback.md is unattended-friendly + durable. Validated by the dogfood.
3. **Orchestrator-verified gates** — never trust the agent's claim. The false-pass gate confirmed this v1 lesson again this week.
4. **Event-log JSONL as source of truth** — structured, appendable, queryable post-hoc.
5. **Work-item schema + dependency graph** — atomic scope, explicit deps, GWT ACs. Right abstraction for PM-to-dev-loop handoff.
6. **Phase isolation + per-phase benchmarks** — fast feedback loops. Why each phase can be improved without touching the rest.
7. **Worktree per initiative** — convergent pattern across `ccswarm`, `ruflo`, Anthropic SDK guidance. Forge does this right.

## 5. Operator-UX direction (agent-flow + the missing pieces)

### What the operator proposed
- Clone agent-flow locally as the operator interaction surface.
- Combine monitoring + chat (agent-flow today is monitoring-only).
- Single network screen for all running agents (not tabs-per-session).
- Sub-agents from the orchestrator (not separate processes) → renders as one tree.
- TMUX possibly.
- Cycles as the tab dimension.

### What the web research found
- **agent-flow** ([patoles/agent-flow](https://github.com/patoles/agent-flow)) is a TUI that watches `~/.claude/projects/` + `~/.codex/sessions/` via hook events. **Monitoring-only**, no chat / no intervention. No plugin/extensibility layer. Lacks task-submission, agent-spawning, or state-mutation APIs.
- **Separate process wins** for production agentic orchestrators (`ruflo`, `ccswarm`, `ralphinho`). Sub-agents are convenience for small bounded tasks, not the orchestration primitive.
- **State machines over logs** for observability. Operator needs to see *state transitions*, not every tool call. Patterns: `ccswarm` MessageBus + `ruflo` checkpoint namespacing.
- **Anthropic SDK sub-agents** can't nest (sub-agents can't spawn sub-agents); inherit parent CLAUDE.md + a tools subset. Not the right primitive for forge's 6-phase model.
- **Hooks + OTLP** for observability — the SDK supports OpenTelemetry export. Forge could plug into the same observability rails as everyone else.

### The synthesis for forge

agent-flow alone is insufficient — it's an observability sidebar, not
a control plane. The operator-UX that captures the intent:

```
┌─ Cycles ──────────────────────────────────────────────────────────┐
│  bett#1   trafficGame#7   slugifier#3 (active)   …                │
├───────────────────────────────────────────────────────────────────┤
│  ┌─ STATE MACHINE ──────┐  ┌─ AGENT-FLOW SIDEBAR ──────────┐      │
│  │ architect  ✓ approved │  │  PM agent: 12s · 3 reads      │      │
│  │ PM         ✓ 6 WIs    │  │  ↳ brain-query (5s)           │      │
│  │ dev-loop   ▶ WI-3/6   │  │  ↳ Glob azuredevops/... (2s)  │      │
│  │ review     ⏸ waiting  │  │                                │      │
│  │ reflect    ⏸           │  │  Dev-loop WI-3:               │      │
│  └───────────────────────┘  │    Ralph iter 2: write _test.go │      │
│                              └────────────────────────────────┘      │
├───────────────────────────────────────────────────────────────────┤
│  ┌─ CHAT/INTERVENTION ────────────────────────────────────────┐    │
│  │ > Send-back WI-3? Or approve and continue?                  │    │
│  │ ...                                                          │    │
│  └─────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

The pieces:
- **Cycles tab dimension** (top) — operator's right intuition.
- **State machine view** (left) — cycle phase progress with operator
  touchpoints surfaced (architect approve, review verdict, reflect Q&A).
- **Agent-flow sidebar** (right) — live per-phase agent activity from
  hook events. Doesn't replace the state view; supplements it.
- **Chat surface** (bottom) — operator can intervene at human-moment
  boundaries (architect interview, review verdict, reflect questions).
  This is what agent-flow doesn't do today.

Build path: fork agent-flow, add state-machine view + chat panel,
re-skin tabs as cycles. The fork is the cheapest path to the right
shape — but `agent-flow`'s lack of plugin layer means it's a hard
fork, not a plugin install.

## 6. Honest reflection on the dogfood

The 2026-05-23 dogfood ran 3 retries, each failing in a different
mode, each hot-patched by an orchestrator code change:

1. **Retry 1** — dev-loop quality gates false-passed (`go test` exit 0
   on no tests). Hot-patched: `NO_WORK_INDICATORS` scan +
   `requiredPaths` check in stop-conditions.ts.
2. **Retry 2** — PM emitted overlapping WIs (`detectHiddenCoupling`
   caught it). Hot-patched: PM SKILL `≤3` brain queries + strengthened
   self-check.
3. **Retry 3** — Claude Code subprocess crashed twice per WI (exit 1).
   Per-WI retry exhausted; cascade-skipped remaining WIs via
   `prerequisiteFailed` (the early-exit fix landed parallel).

**Each fix only catches its own failure mode.** The retry-3 crash
wasn't gate-fixable — it was an environmental issue (likely the same
spawn-env problem we hit before the cycle even started). No
orchestrator-side fix would have caught it.

**This pattern is the signal that motivates the rebuild lens.** A
system where every defect class is unique + every fix is
orchestrator-side is a system whose **inter-dependencies are too
tight**. The rebuild target: each phase fails (and recovers) in its
own surface, without spreading complexity to a central coordinator.

## 7. Three concrete next moves (in priority order)

### Move 1 (1-2 stages of work): Slim the orchestrator
- Pull `demo*.ts`, `cycle-report.ts`, `preflight.ts`,
  `brain-bench-promote.ts`, `metrics.ts`, `logging-pretty.ts` out of
  the orchestrator. Move to `cli/`. Update tests + CLI subcommands.
- Estimated: 2-3000 LOC moved out, 0 functional regression. Cleaner
  `orchestrator/` surface — easier to reason about + test.
- Acceptance: cycle still runs end-to-end; CLI utilities still work.

### Move 2 (3-4 stages): Build the operator UI
- Fork agent-flow OR clone its observability rails into a new
  `forge-ui/` package.
- Add state-machine view (per-cycle phase progress).
- Add chat surface (operator-intervention at human-moment boundaries).
- Re-skin tabs as cycles (not sessions).
- Estimated: 1-2 weeks of focused work; high operator-value.
- Acceptance: operator runs a betterado cycle end-to-end watching it
  from `forge-ui/` without ever touching `tail -f events.jsonl`.

### Move 3 (orthogonal): Address the dogfood's third failure
- The Claude Code subprocess crash on retry-3 needs investigation
  independent of forge's design. Likely a Claude Code v2.1 bug or
  env/PATH leak in the SDK spawn. Not forge's bug to fix at the
  orchestrator level — capture the cycle archive (already done) +
  file upstream once the crash is reproducible.

## 8. Forge phase architecture (preserved — for grounding)

```
 architect (operator) → PM → dev-loop → unifier → review (operator) → reflect (operator)
                              ↑                                            ↓
                          per-WI Ralph                                brain writes
                              ↑                                            ↓
                          quality gate                              cycle archive
```

The 6-phase model itself is sound. The rebuild moves logic to the
right phases — not to a central orchestrator.

## 9. Sources

- Codebase audit (this session, sub-agent Explore)
- Web research:
  - [patoles/agent-flow](https://github.com/patoles/agent-flow)
  - [anthropics/cwc-workshops](https://github.com/anthropics/cwc-workshops)
  - [ruvnet/ruflo](https://github.com/ruvnet/ruflo)
  - [nwiizo/ccswarm](https://github.com/nwiizo/ccswarm)
  - [affaan-m/everything-claude-code/ralphinho-rfc-pipeline](https://github.com/affaan-m/everything-claude-code/tree/main/skills/ralphinho-rfc-pipeline)
  - [Claude Agent SDK — Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
  - [Claude Agent SDK — Observability (OTLP)](https://code.claude.com/docs/en/agent-sdk/observability)
  - [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- Retry-3 forensics (sub-agent Explore) — `_logs/2026-05-23T12-55-57_INIT-2026-05-23-release-def-substrate-gates/events.jsonl`

## 10. Operator wake-up notes

- The retry-3 manifest is in `_queue/failed/`. Worktree wiped, remote
  branches clean. Next session starts clean.
- Brain themes from this dogfood committed: `quality-gate-cmd-must-assert-new-work`,
  `pm-bounded-brain-query`, `2026-05-23-dogfood-cycle-false-pass-gate`,
  plus cycle archive at `brain/_raw/cycles/2026-05-23_betterado-init01-dogfood-abandoned-arc.md`.
- Memories saved for cross-session pickup: `project_iteration_refinement_targets`
  + `project_rebuild_review_brief`.
- Recommended first action next session: pick Move 1 OR Move 2; both
  are roughly 1-2 stages of work and either is a substantial step
  toward the v3 shape.
