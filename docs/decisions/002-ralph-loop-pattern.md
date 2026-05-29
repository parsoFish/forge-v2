# ADR 002 — Ralph loop pattern over Claude Agent SDK

**Status:** Accepted (scaffold)
**Date:** 2026-04-24

## Context

The developer phase needs to iterate on a work item until quality gates pass — write code, run tests, fix what's broken, repeat. V1 modelled this as a sequence of stage agents (`plan → test → develop → pr`), each invoked once, each potentially retried by the orchestrator. That worked but conflated "agent ran" with "work item complete," and added retry/fix-loop machinery to the orchestrator itself.

A simpler, more battle-tested approach exists: the **Ralph loop pattern** (Geoffrey Huntley, late 2025). The loop is the entire developer phase. Iteration happens inside the loop, not at the orchestrator.

## Decision

The developer loop is implemented as the **Ralph loop pattern**:

```
loop:
  read PROMPT.md, AGENT.md (institutional memory), specs/, fix_plan.md
  call the underlying agent (Claude Agent SDK query()) against the worktree
  commit changes
  check stop conditions
  if stop: exit loop with success/failure
  else: update fix_plan.md with what's left, repeat
```

Implementation:
- [`loops/ralph/runner.ts`](../../loops/ralph/runner.ts) — the ~30-line driver.
- [`loops/ralph/PROMPT.md.tmpl`](../../loops/ralph/PROMPT.md.tmpl) — template stamped per work item from project-manager output.
- [`loops/ralph/AGENT.md.tmpl`](../../loops/ralph/AGENT.md.tmpl) — institutional memory template (what the agent has tried, what worked, what didn't).
- [`loops/ralph/stop-conditions.ts`](../../loops/ralph/stop-conditions.ts) — pluggable stop checks (quality gates pass, iteration budget exceeded, wedged-detector).

> Note (2026-05-25): wedged-detection was removed in Tier 2. The iteration budget is now the only no-progress backstop; the `wedged-detector` stop check is no longer live.

The pattern is **agent-swappable**: `loops/_adapters/` will hold future hermes/aider/openhands adapters that implement the same loop shape with different underlying agents, so they can be A/B'd.

## Consequences

**Positive:**
- The developer phase is one process, not a stage pipeline. Drastically simpler.
- Retry/fix-loop logic lives where the work happens, not in the orchestrator.
- Pattern is community-validated, with reference implementations from Anthropic, Vercel, and others.
- Slot-in for other community loops as adapters.

**Negative / accepted trade-offs:**
- No built-in stop condition — we bolt one on (`stop-conditions.ts`).
- No built-in merge-conflict handling — handled inside the loop's prompts plus orchestrator-level worktree isolation.
- Can burn tokens if stop conditions are wrong; `iteration_budget` and `cost_budget_usd` in the initiative manifest cap this.

## Alternatives considered

- **V1's stage pipeline** — strictly more orchestration code and worse error handling. Rejected.
- **Hermes Agent** as the loop runtime — duplicates the brain (Hermes has its own persistent memory). Rejected for that reason; keeping the brain layer pure.
- **OpenClaw** — heavyweight app, opinionated about its skill registry, conflicts with our `skills/` directory. Rejected.
- **No loop, agent one-shots** — observed in v1 to be the dominant cause of incomplete work items. Rejected.

## References

- [Ralph Wiggum as a "software engineer" — Geoffrey Huntley](https://ghuntley.com/ralph/)
- [ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
- [anthropics/claude-code ralph-wiggum plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
- [vercel-labs/ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent)
- [HumanLayer — A Brief History of Ralph](https://www.humanlayer.dev/blog/brief-history-of-ralph)
