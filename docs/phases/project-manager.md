# Phase: Project Manager

> *Unattended.* Breaks initiative features into spec-driven work items the developer loop can execute.

## Purpose

Take the architect's confirmed initiative and decompose its features into **work items** — atomic, dependency-ordered units with acceptance criteria the developer loop can verify. Designed for *iteration* (not one-shotting); designed for *parallelism* (declared dependencies allow safe parallel execution).

## Inputs

- `_queue/in-flight/<initiative-id>.md` (the initiative manifest, claimed by the scheduler).
- `projects/<name>/` (current project state at the worktree's HEAD).
- Brain knowledge (queried via `brain-query`).

## Outputs

- `<worktree>/.forge/work-items/WI-<n>.md` — one file per work item, frontmatter + spec body. **Schema locked in [ADR 015](../decisions/015-work-item-format.md).**
- `<worktree>/.forge/work-items/_graph.md` — dependency graph (mermaid `graph TD`) for human review. **Format locked in [ADR 015](../decisions/015-work-item-format.md).**

Validation enforced by [`orchestrator/work-item.ts:validateWorkItem`](../../orchestrator/work-item.ts) before the orchestrator dispatches work items to the developer loop.

## Skills

- [`skills/project-manager/SKILL.md`](../../skills/project-manager/SKILL.md)

## Success signals

- **Atomicity:** each work item touches ≤3 files (target; not absolute).
- **Verifiability:** each work item has at least one Given-When-Then acceptance criterion.
- **Parallelism:** at least 30% of work items can run in parallel (no dependency edge between them).
- **Downstream completion:** work items emitted by the PM have a higher developer-loop completion rate than hand-written ones.
- **No clarification asks:** the developer loop never has to come back to the PM for clarification (self-sufficient specs).

## Benchmark suite

[`benchmarks/project-manager/`](../../benchmarks/project-manager/)
- `initiatives.json` — five fixtures, one per managed project, calibrated against project-specific brain themes. See the [bench README](../../benchmarks/project-manager/README.md).
- `score.ts` — invokes the PM skill against fixtures and scores six weighted criteria; pass threshold 0.7.
- `scoring.ts` / `sdk.ts` / unit tests — pure scoring functions and the SDK invocation shim, both unit-tested.

The bench's invocation contract lives in [`orchestrator/pm-invocation.ts`](../../orchestrator/pm-invocation.ts) and is shared with the live cycle in [`orchestrator/cycle.ts`](../../orchestrator/cycle.ts) — one source of truth for the PM's system prompt + user prompt.

## Locked formats

- Work-item file schema, `_graph.md` mermaid format, work-item-id scheme (`WI-<n>` per-initiative): all locked in [ADR 015](../decisions/015-work-item-format.md).
- Validation: [`orchestrator/work-item.ts`](../../orchestrator/work-item.ts) — `parseWorkItem` / `validateWorkItem` / `validateWorkItemSet` / `detectHiddenCoupling`.

## Known failure modes (to defend against)

- **Over-decomposition** — 50 work items for a 3-day feature. Capped via the bench's `work_item_count_in_range` criterion + prompt guidance.
- **Under-decomposition** — one giant work item. Same.
- **Vague acceptance criteria** — passes the buck to the developer loop. Bench's highest-weighted criterion (`every_item_has_gwt` at 0.25) explicitly scores Given-When-Then completeness.
- **Hidden dependencies** — work items collide at merge time. PM's last-step self-check (`detectHiddenCoupling`) drives the bench's `no_hidden_coupling` criterion.
