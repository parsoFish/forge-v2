# Architecture

> This document is the **narrative / intended** architecture. For the
> **honest as-built** (what the code actually does, with Mermaid graphs)
> see [`docs/architecture/as-built-snapshot-2026-05-17.md`](./docs/architecture/as-built-snapshot-2026-05-17.md);
> where the two differ, the snapshot is the truth. ADRs in
> [`docs/decisions/`](./docs/decisions/) record load-bearing decisions.
>
> **Reconciled 2026-05-16**, refreshed **2026-05-17** post-closure. Key
> divergences from the idealised description below: (a) **5 phases are
> wired into `runCycle`; the architect is a deliberate out-of-cycle
> human moment** (slash command, not a wired phase); (b) **brain-first
> is narrowed** — the planner and reflector read the brain; the dev-loop
> and reviewer do not (see [ADR 010](./docs/decisions/010-brain-first.md)
> + `brain/cycles/themes/brain-read-policy.md`); (c) the **review-phase
> redesign has LANDED** — no auto-merge; the GitHub PR is the operator's
> surface; `closure.ts` is the single terminal-move authority and
> reflection fires only on a confirmed merge
> (`brain/cycles/themes/review-phase-target-design.md`; the snapshot's §G
> is now the as-built, not a target).

## Overview

Forge is six phases backed by a brain. Five run in sequence inside
`runCycle` (project-manager → developer-loop → review-loop →
reflection, with the architect as a human moment that produces the
initiative). The brain is read by the **planning** phases and the
reflector as a first source of knowledge, and written to at the end of
every cycle; the dev-loop and reviewer take their intent solely from
the planner's work items.

![forge2.0 architecture](./docs/architecture/forge2.0.drawio.png)

```
                              ┌──────────┐
                              │  Brain   │ ◄───────────────────────────┐
                              │  (wiki)  │                              │
                              └────┬─────┘                              │
                                   │ queried by every phase             │ ingest
                                   ▼                                    │
   user ──► Architect ──► Project Manager ──► Developer Loop ──► Review Loop ──► Reflection
              ▲                                                       ▲             ▲
              │                                                       │             │
            user                                                    user          user
        (interactive)                                          (interactive)  (interactive)
```

### Artifact flow

```
Roadmap ──► Initiative ──► Feature ──► Work item ──┐
                                                     │
                                                     ▼
                                          (developer loop iterates)
                                                     │
                                                     ▼
                                              Review-ready PR
```

### Branch flow

```
main ◄── (review loop merges) ──── initiative branch ◄── feature branches
```

## The phases

### 1. Brain

The brain is the system's memory. It is a **Karpathy-style LLM wiki** with three layers:

After the **Tier 4 three-brain restructure (2026-05-26)**, three scoped brains:
- **Brain 1 (forge-dev):** `brain/forge-dev/` — forge TypeScript source knowledge + ADRs + engineering notes.
- **Brain 2 (cycles):** `brain/cycles/` — cycle-derived patterns, antipatterns, raw archives. `brain/cycles/_raw/` holds immutable cycle records.
- **Brain 3 (per-project):** `<project-repo>/brain/` — lives inside each managed project's repo.

Layer structure (each brain follows this pattern):
1. **`_raw/`** — immutable raw sources. Ground truth.
2. **`themes/`** — small (~15-40 line) theme pages indexing the raw layer.
3. **Category indexes + `profile.md`** — navigation pointing to theme pages.

The brain is **rendered as an Obsidian vault** so humans navigate the same graph the agents query.

The brain is itself a small set of agents (Claude Code skills):
- **`brain-ingest`** — writes new theme pages / appends raw sources from research or learnings.
- **`brain-lint`** — surfaces conflicts, fixes structural issues, raises ambiguities to the human.
- **`brain-query`** — efficient lookup for use by every other skill (mandated as their first action).

### 2. Architect *(human-in-the-loop)*

The architect is **a Claude Code skill the user invokes during ideation sessions**. It is not a hand-rolled subprocess.

Responsibility: turn ideas + existing roadmap + brain knowledge into **initiatives** — coherent collections of features that move a project to a desired state.

Critically, the architect uses the **LLM Council pattern** ([`skills/architect-llm-council/`](./skills/architect-llm-council/)) — a chain of perspectives (CEO, eng, design, DX) that auto-resolves mechanical questions and only escalates the taste decisions. Inspired by gstack's `/autoplan`.

Once the user confirms the initiative, the architect knows it will be worked on entirely by agents until the review loop — that's the *next* human interaction point.

**Intentionally out-of-cycle (by design, not a gap).** The architect is
**not** wired into `runCycle` and is **not** auto-invoked: it is a
deliberate human moment the operator runs in their own Claude session
via the **`/forge-architect`** slash command
([`.claude/commands/forge-architect.md`](./.claude/commands/forge-architect.md)).
Its only handoff to forge is the files it writes
(`_queue/pending/INIT-*.md` + roadmap rows); the scheduler picks those
up unattended. Design of record:
[`brain/cycles/themes/human-interaction-via-own-session.md`](./brain/cycles/themes/human-interaction-via-own-session.md)
(resolves retro Q4; US-3.1 / US-1.0).

### 3. Project Manager *(unattended)*

Responsibility: break initiative features into **work items** with explicit dependencies and acceptance criteria.

Work items follow a **spec-driven format** designed for the agentic developer loop:
- Atomic scope (1-3 files where possible).
- Given-When-Then acceptance criteria.
- Explicit success signals the developer loop can verify.
- Designed for *iteration*, not one-shotting.
- Inter-item dependencies declared so parallel work is safe.

The PM uses the brain first; researches more broadly only when the brain is insufficient. It is fully automated and emits structured logs that the reflector reads.

### 4. Developer Loop *(unattended)*

The developer loop is **the Ralph loop pattern** ([ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)) implemented over the **Claude Agent SDK**.

```
loop:
  read PROMPT.md, AGENT.md (institutional memory), specs/, fix_plan.md
  call query() against the worktree
  commit changes
  check stop conditions (quality gates pass | iteration budget | wedged)
```

Key properties:
- **Loop runtime is swappable** — `loops/_adapters/` is the placeholder for future hermes/aider/openhands adapters that can be A/B'd against Ralph.
- **Parallel work** = N git worktrees × N Ralph instances, coordinated by the orchestrator's scheduler.
- **The developer loop is *complete* for an initiative** when all work items + features have landed in the initiative branch with all checks passing.
- **Merge conflict handling** is part of the loop, not the orchestrator.

### 5. Review Loop *(human-in-the-loop)*

Responsibility: closeout of an initiative back to main.

**Unified Ralph runner** (post-pass-1 design — earlier drafts had this split into two phases; the implementation collapsed them after the e2e bench surfaced redundant state shuffling). One Ralph loop on the initiative branch, parameterised by a reviewer system prompt + a verdict-aware quality gate. Iteration 1 prepares the demo + PR draft from scratch; iterations 2+ react to send-back feedback the verdict gate appends to `fix_plan.md`.

The verdict gate (the developer-loop unifier sub-phase's quality gate in [`orchestrator/unifier-invocation.ts`](./orchestrator/unifier-invocation.ts) + verdict providers in [`orchestrator/file-verdict.ts`](./orchestrator/file-verdict.ts) / [`orchestrator/pr-verdict.ts`](./orchestrator/pr-verdict.ts)) runs between iterations and:

1. **Re-runs the project quality gate** (orchestrator-verified — never trusts the agent's claim).
2. **Asks the verdict provider** — production: file-based handoff written by the operator via the **`/forge-review <id>`** slash command (the operator's own Claude session). Bench: simulator agent.
3. **On approve** → the review *gate* is released (this is **not** a merge — Phase 6 / G9): `runReviewer` opens a demo-embedded PR on the project repo and **STOPS**. **On send-back** → feedback is appended to `fix_plan.md` as Given/When/Then ACs; loop continues.

**Self-contained PR (2026-05-18).** `pr.ts:embedDemoInPr` commits the demo bundle to a tracked `demo/<id>/` on the branch (before the push) and writes a visibility-aware PR body — a relative-link `DEMO.md` for **private** repos (GitHub's image proxy can't fetch private raw URLs), inline raw images for public. The operator reviews entirely from the PR; iterating via PR comments is a supported lightweight loop (pattern: `brain/cycles/themes/pr-as-sole-review-window.md`).

**No auto-merge.** The GitHub PR is the operator's merge + feedback surface. The operator merges it in GitHub (or via `/forge-review`); a later `runClosure` confirms the merge (`gh pr view --json state` == `MERGED`), then `alignLocalToRemote` brings the **project's working tree** forward to the merged `main` (a guarded `merge --ff-only`, **stashing/restoring any uncommitted operator state** such as `roadmap.md` — never a bare ref move that strands the working tree) and prunes the branch, moves the manifest `in-flight/ → done/` (so **`done/` ⇒ MERGED**), and only then does reflection fire. `closure.ts` is the **single terminal-move authority**; the reviewer moves no manifest. Until the operator merges, the unattended cycle terminates at `pr-open` (not a failure).

Cap: 3 iterations (1 prep + ≤2 send-back rounds), scaled up for very large diffs (`computeAdaptiveReviewIterationCap`). There is **no per-iteration $/turn budget guard** on the reviewer agent (removed 2026-05-18 — it was undersized and cut every iteration before a verdict); the loop is bounded only by this iteration cap. Cap-exhausted leaves the manifest in `_queue/ready-for-review/` for manual operator pickup; never a hard cycle failure.

Like the architect, the review loop is best implemented as **Claude Code skills the user invokes**, so it benefits directly from agentic-wrapper improvements.

### 6. Reflection *(human-in-the-loop, then unattended ingest)*

Triggered after initiative closeout. Three scopes:

1. **Agentic self-reflection** — the agent reviews its own performance: digests the JSONL event log, counts iterations needed at each level (work item → feature → review → initiative), spots antipatterns.
2. **Agent-prompted user questions** — the agent asks the user only what it cannot resolve from established principles + brain knowledge.
3. **Pure user feedback** — the user's free-form observations.

All three feed `brain-ingest`, which is what makes forge learn cycle-over-cycle.

## Cross-cutting concerns

### Unattended operation

Three human interaction points, each run in the **operator's own Claude
session** as a slash command — never a forge-spawned agent and never a
bench simulator in production
([`brain/cycles/themes/human-interaction-via-own-session.md`](./brain/cycles/themes/human-interaction-via-own-session.md)):

| Moment | Command | File handoff |
|---|---|---|
| Architect *(out-of-cycle — not wired into `runCycle`)* | [`/forge-architect`](./.claude/commands/forge-architect.md) | writes `_queue/pending/INIT-*.md` + roadmap rows |
| Review *(engage the open PR)* | [`/forge-review <id>`](./.claude/commands/forge-review.md) | verdict-response file, or merge the PR in GitHub |
| Reflection *(stage-3 feedback)* | [`/forge-reflect <id>`](./.claude/commands/forge-reflect.md) | writes `_logs/<id>/user-feedback.md` |

Everything else runs unattended for arbitrary durations via:

- **`_queue/` state-machine directories** (`pending → in-flight → ready-for-review → done | failed`).
- **`orchestrator/scheduler.ts`** (~150-line persistent loop) that claims initiatives, spawns each in a `git worktree`, writes a heartbeat, surfaces completion via notification.
- **Crash recovery** by atomic claim + heartbeat: orphaned in-flight items return to `pending/` on restart.

This is **not v1's job queue + worker + resource controller**. See ADR 011-013 for the line we're holding.

### Brain-first research

Every skill mandates `brain-query` as its first action. Broader research (web, docs) happens only when the brain proves insufficient — and the gap is logged so the next ingest pass can fill it.

### Logging & visualisation

Every skill invocation emits a structured event to `_logs/<cycle-id>/events.jsonl` (schema in [`docs/decisions/008-jsonl-event-log.md`](./docs/decisions/008-jsonl-event-log.md)). The event log is the source of truth for:

- **Reflection** (replay what happened).
- **Visualisation** (`forge status`, `monitor/tmux.sh`, live phase view).
- **Metrics** (cost, iterations, duration per phase / skill / initiative).

### Phase isolation & benchmarks

Each phase has a sample-input → measurable-output benchmark suite under `benchmarks/<phase>/`. A session can prove "the architect got better" without running a full cycle. This is what makes the system tractable to improve incrementally.

## What forge is *not*

- It is not a job queue with priorities and dedup. (See ADR 011.)
- It is not a resource controller. (`maxConcurrentInitiatives` is a static knob.)
- It is not a per-project agent personality. (Skills are shared; per-project taste lives in `<project-repo>/brain/profile.md`.)
- It does not retry failed initiatives automatically. (Failure → human triage.)
- It does not host its own model runtime, vector DB, or agent harness. (Claude Agent SDK does that.)
