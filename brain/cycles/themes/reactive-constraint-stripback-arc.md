---
title: >-
  Agent-facing constraints masked structural bugs — diagnose cwd/state before
  adding gates
description: >-
  F-35..F-43 arc — the PM path validator, per-WI brain-first gate, brain index,
  noop stop condition all got ripped out. The real bugs were cwd=forgeRoot
  (F-37) and shared Ralph scratch (F-40). Constraints added false-positive
  surface and hid root causes.
category: antipattern
keywords:
  - over-restriction
  - strip-back
  - false-positives
  - cwd-forgeroot
  - shared-scratch
  - brain-first-gate
  - path-validator
  - root-cause
  - F-34
  - F-37
  - F-39
  - F-40
  - F-41
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-16T00:00:00.000Z
related_themes:
  - brain-first-research
  - ralph-loop-pattern
  - quality-gates-orchestrator-verified
  - simplicity-as-architecture
---

# Agent-facing constraints masked structural bugs

The trafficGame reliability arc was driven by **removing** constraints,
not adding them. The original dev-loop/PM scaffolding shipped with a
tight `files_in_scope` gate, a per-WI brain-first runtime gate, a ~17KB
brain index in the system prompt, a noop-completion stop condition,
$0.30/3-iter budgets, and a PM path-fabrication validator. Live runs
failed; nearly every fix was a deletion.

The constraints were **diagnosing the wrong root causes**:

- The PM path-hallucination saga (F-35/F-36 added a validator to "catch"
  fabricated paths) had a structural cause: the PM agent ran with
  `cwd=forgeRoot`, so `Glob src/**` resolved against forge's own tree
  and returned nothing, so the agent fabricated from priors. **F-37**
  (`cwd=worktree`, one line) was the real fix; **F-39** then ripped the
  validator out as redundant and false-positive-prone (it flagged 16
  legitimate new-test paths).
- "No-op completions" (F-32 added a stop condition; F-34c reverted it)
  had a structural cause: idempotent `prepareDevWorkspace` left WI-1's
  satisfied `AGENT.md`/`fix_plan.md` in place, so WI-2 read a done
  checklist and exited. **F-40** (wipe scratch between WIs, 3 lines) was
  the real fix.
- F-34/F-41 stripped the brain index + per-WI brain-first gate from
  dev-loop and reviewer entirely; F-42 tripled the PM budget after a
  $1 cap killed a legitimate decomposition at 0 WIs.

Core lesson: **before adding an agent-facing constraint to catch a
failure, find the structural cause (cwd, shared state, env).** A
constraint that fires on a symptom adds its own false-positive failure
surface and hides the bug it was meant to expose. "Partially addressed"
is accurate — the strip-backs were reactive and per-incident, never a
deliberate redesign.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: the F-24…F-44 change list.
- [`retro.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/retro.md) — §2 "how forge shifted", I2/I4/I5 stale-surface findings.

## See also

- [[brain-first-research]] — the mandate that was deliberately narrowed to PM/reflector only.
- [[ralph-loop-pattern]] — where the shared-scratch bug lived.
- [[quality-gates-orchestrator-verified]] — quality gates verified by the orchestrator, not the agent.
- [[simplicity-as-architecture]] — the principle the strip-backs restored.
