# Architecture

> This document is the **narrative / intended** architecture. For the
> **honest as-built** (what the code actually does, with Mermaid graphs)
> see [`docs/architecture/as-built-snapshot-2026-05-16.md`](./docs/architecture/as-built-snapshot-2026-05-16.md);
> where the two differ, the snapshot is the truth. ADRs in
> [`docs/decisions/`](./docs/decisions/) record load-bearing decisions.
>
> **Reconciled 2026-05-16** with the as-built. Key divergences from the
> idealised description below: (a) **5 phases are wired into `runCycle`;
> the architect is a deliberate out-of-cycle human moment** (slash
> command, not a wired phase); (b) **brain-first is narrowed** — the
> planner and reflector read the brain; the dev-loop and reviewer do
> not (see [ADR 010](./docs/decisions/010-brain-first.md) +
> `brain/forge/themes/brain-read-policy.md`); (c) the **review phase is
> being redesigned** (no auto-merge; PR is the human surface;
> `brain/forge/themes/review-phase-target-design.md`).

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

1. **`brain/_raw/`** — immutable raw sources (research, logs, ingested third-party docs). Ground truth.
2. **`brain/forge/themes/` and `brain/projects/<name>/themes/`** — small (~15-40 line) theme pages indexing the raw layer.
3. **`brain/INDEX.md` + `brain/forge/{patterns,antipatterns,decisions,operations}.md` + per-project `profile.md`** — category indexes pointing to theme pages.

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

The verdict gate (`orchestrator/reviewer-stage2.ts`) runs between iterations and:

1. **Re-runs the project quality gate** (orchestrator-verified — never trusts the agent's claim).
2. **Asks the verdict provider** — production: file-based handoff (`_queue/in-flight/<id>.verdict-prompt.md` written by the orchestrator; `_queue/in-flight/<id>.verdict-response.md` written by the operator via `forge review <id>`). Bench: simulator agent.
3. **On approve** → loop stops, orchestrator merges + moves manifest to `_queue/done/`. **On send-back** → feedback is appended to `fix_plan.md` as Given/When/Then ACs; loop continues.

Cap: 3 iterations (1 prep + ≤2 send-back rounds). Cap-exhausted leaves the manifest in `_queue/ready-for-review/` for manual operator pickup; never a hard cycle failure.

Like the architect, the review loop is best implemented as **Claude Code skills the user invokes**, so it benefits directly from agentic-wrapper improvements.

### 6. Reflection *(human-in-the-loop, then unattended ingest)*

Triggered after initiative closeout. Three scopes:

1. **Agentic self-reflection** — the agent reviews its own performance: digests the JSONL event log, counts iterations needed at each level (work item → feature → review → initiative), spots antipatterns.
2. **Agent-prompted user questions** — the agent asks the user only what it cannot resolve from established principles + brain knowledge.
3. **Pure user feedback** — the user's free-form observations.

All three feed `brain-ingest`, which is what makes forge learn cycle-over-cycle.

## Cross-cutting concerns

### Unattended operation

Three human interaction points: Architect, Review, Reflection. Everything else runs unattended for arbitrary durations via:

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
- It is not a per-project agent personality. (Skills are shared; per-project taste lives in `brain/projects/<name>/profile.md`.)
- It does not retry failed initiatives automatically. (Failure → human triage.)
- It does not host its own model runtime, vector DB, or agent harness. (Claude Agent SDK does that.)
