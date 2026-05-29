# Skills

> Every "agent" in forge is a Claude Code skill. See [ADR 003](../docs/decisions/003-skills-not-self-baked-agents.md).

## How to use

Skills are designed to be invoked from two surfaces:

1. **Interactive Claude Code session** — the user types `/architect`, `/reviewer`, `/reflector` in a Claude Code session and the skill takes over for that phase.
2. **Programmatic via the orchestrator** — `orchestrator/cycle.ts` and `loops/ralph/runner.ts` invoke skills via the Claude Agent SDK in unattended runs.

Both surfaces use the same `SKILL.md` — that file is the contract.

## Skill inventory

| Skill | Phase | Surface | Purpose |
|---|---|---|---|
| [`architect`](./architect/SKILL.md) | Architect | interactive | Turn ideas + roadmap into initiatives |
| [`architect-llm-council`](./architect-llm-council/SKILL.md) | Architect | interactive (sub) | Multi-perspective critic chain (CEO/eng/design/DX) |
| [`project-manager`](./project-manager/SKILL.md) | Project Manager | unattended | Initiative → work-item specs |
| [`developer-ralph`](./developer-ralph/SKILL.md) | Developer Loop | unattended | Launch the Ralph loop for a work item |
| [`reviewer`](./reviewer/SKILL.md) | Review Loop | unattended → interactive | Review-prep + reviewer persona |
| [`reflector`](./reflector/SKILL.md) | Reflection | interactive → unattended | Cycle retrospective + brain ingest |
| [`brain-ingest`](./brain-ingest/SKILL.md) | Brain | unattended | Append raw, create theme pages |
| [`brain-lint`](./brain-lint/SKILL.md) | Brain | unattended | Structural integrity checks |
| [`brain-query`](./brain-query/SKILL.md) | Brain | unattended | Mandated first action of every other skill |

## Authoring conventions

Every `SKILL.md` follows the same shape:

```markdown
---
name: <skill-name>
description: <one-line>
phase: brain | architect | project-manager | developer-loop | review-loop | reflection
surface: interactive | unattended | both
model: claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | default
---

# <Skill name>

## Single responsibility
<One paragraph.>

## Required first action
Invoke `brain-query` with: ...

## Inputs
- ...

## Outputs
- ...

## Event-log entries to emit
- ...

## Process
<Step-by-step. Brief.>
```

## Adding a new skill

1. Create `skills/<name>/SKILL.md` following the shape above.
2. Add a row to the inventory table here.
3. If it's used by the orchestrator, register it in `orchestrator/cycle.ts`.
4. Validate behaviour against real merged cycles (the `benchmarks/` harnesses were removed 2026-05-25).
