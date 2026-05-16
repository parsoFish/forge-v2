# Principles

These are the five user-stated principles that gate every decision in forge v2. They are reproduced verbatim from the prompt that initiated the v2 scaffold, with brief commentary linking each to the ADR that codifies it.

---

## 1. Avoid hand-rolling solutions

> Avoid hand rolling solutions at all cost if there are existing solutions that fill the requirements of a component in the forge architecture, and wherever possible plug into solutions that are already heavily in use such as claude, github copilot, etc. The prime example is the agentic loop, solutions like hermes or ralph loops must be utilised over a hand rolled solution that tries to implement the same function. These solutions are at this stage battle tested and likely more powerful than any solution I could come up with on my own given the community support and attention and this sort of ideal holds true for any componentry. I think my idea is powerful in hanging other powerful ideas together, not in building the entire thing from scratch.

**Codified by:**
- [ADR 001 — Claude Agent SDK as the agent runtime](./docs/decisions/001-claude-agent-sdk.md)
- [ADR 002 — Ralph loop pattern over Claude Agent SDK](./docs/decisions/002-ralph-loop-pattern.md)
- [ADR 003 — All "agents" are Claude Code skills](./docs/decisions/003-skills-not-self-baked-agents.md)
- [ADR 006 — gh CLI + git worktrees + GitHub Actions instead of self-baked git/job runners](./docs/decisions/006-gh-cli-and-worktrees.md)

---

## 2. Simplicity is key

> Simplicity is key and is powerful, I have seen some incredible solutions built entirely out of only a handful of skills, agent personas, and some scripts or tools that those agents know how to utilise well.

**Codified by:**
- [ADR 003 — All "agents" are Claude Code skills](./docs/decisions/003-skills-not-self-baked-agents.md)
- [ADR 007 — Markdown artifacts flow phase-to-phase](./docs/decisions/007-markdown-artifact-flow.md)
- [ADR 009 — Minimal `forge.config.json`; settings live in skills/ADRs](./docs/decisions/009-minimal-config.md)

The non-goals section of [`docs/decisions/`](./docs/decisions/) is also load-bearing here: every "no" defends this principle.

---

## 3. Phase isolation with fast feedback

> Isolation of forge phases to enable focused work on any individual phase. Each phase should have clear success signals that allow agents to work on a phase and prove their changes are making a meaningful impact. The brain for example should be able to be asked questions before and after updates and noticeable increase in quality, accuracy, or speed of response are observed. The architect similarly should be able to be given sample ideas that will result in a roadmap that can be judged on core metrics for improvement after changes. The feedback loop for agents must be present throughout each component of forge and must enable the fastest feedback possible to allow rapid iteration with benchmarked results to allow an agent to know if its making meaningful and productive change.

**Codified by:**
- [ADR 005 — Phase isolation with per-phase benchmarks](./docs/decisions/005-phase-isolation-with-benchmarks.md)
- [`benchmarks/`](./benchmarks/) — one suite per phase, with a documented input format and scoring metric
- Each phase's [`docs/phases/<phase>.md`](./docs/phases/) names the benchmark suite that gates "did this phase get better?"

---

## 4. Brain-first research

> All components must use the brain as a first source of knowledge but must also be able to research further as required when the brain is unable to provide necessary details or information.

**Codified by:**
- [ADR 010 — Brain-first research](./docs/decisions/010-brain-first.md) (amended 2026-05-16)
- The principle holds where it earns its keep: the **planner**
  (architect / project-manager) and the **reflector** read the brain.
  The **dev-loop and reviewer do not** — their intent is wholly in the
  work items the planner authored, so "research further" for them means
  reading the WI, not the brain. Rationale:
  [`brain/forge/themes/brain-read-policy.md`](./brain/forge/themes/brain-read-policy.md).
- The `brain-query` skill logs gaps so the next ingest pass can fill them — a self-improving loop.

---

## 5. Logging, metrics, and visualisation

> All components must clearly log actions, inputs, and outputs in order to allow for reflection at the end of a cycle. Iterations of agentic loops must be tracked, and basically any valuable metric you can think of should be tracked. This should also be utilised to enable monitoring of the forge cycles as they are running with some form of visualisation of the agents at work.

**Codified by:**
- [ADR 008 — JSONL event log per cycle](./docs/decisions/008-jsonl-event-log.md)
- [`orchestrator/logging.ts`](./orchestrator/logging.ts) — central event-log writer with documented schema
- [`orchestrator/metrics.ts`](./orchestrator/metrics.ts) — aggregations (cost, iterations, duration)
- [`orchestrator/visualise.ts`](./orchestrator/visualise.ts) and [`monitor/`](./monitor/) — live monitoring
