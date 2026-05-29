---
title: >-
  Human interaction points run in the operator's own Claude session via slash
  commands
description: >-
  The three deliberate human moments (roadmap/architect, review feedback &
  merge, reflection feedback) must be undertaken in the operator's own Claude
  session (CLI / VSCode extension), not a forge-spawned agent. Implement as
  slash commands. Forge must never simulate these in production.
category: decision
keywords:
  - human-interaction
  - slash-commands
  - own-session
  - architect
  - review
  - reflection
  - path-b
  - no-simulation
  - three-moments
  - file-handoff
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-29T00:00:00.000Z
related_themes:
  - review-phase-target-design
  - forge-current-architecture-as-built
  - human-directed-work-as-initiatives
  - six-phases-of-forge
---

# Human interaction points run in the operator's own session

> **Amended 2026-05-29 ([ADR 020](../../../docs/decisions/020-architect-in-ui.md)).**
> The **architect** moment moved *into the forge UI* as an operator-driven,
> file-checkpointed runner (idea → interview → council → comparative PLAN →
> approve, all in-app). The load-bearing property below — **explicit,
> operator-initiated, impossible to silently auto-satisfy** — is preserved, not
> the literal "operator's own CLI session": forge never auto-starts the
> architect (only an operator "New idea" action does; it stays out of the
> scheduler / `runCycle`), and there is no auto-approve (the operator must
> resolve every escalation on the PLAN gate before any manifest is queued). The
> interview uses the same **file-based handoff** the reflector uses
> (`questions.json` ↔ `answers.json`). Review + reflection remain own-session
> slash commands as below.

Forge has exactly **three deliberate human interaction moments**. The
operator's direction: each is performed in the operator's **own Claude
session** (CLI or VSCode extension) — not a forge-spawned sub-agent and
not a bench simulator standing in for production. The cleanest
implementation is a **slash command** per moment.

| Moment | Surface | Reads | Writes / effect |
|---|---|---|---|
| Roadmap / architect | **in-UI architect** ([ADR 020](../../../docs/decisions/020-architect-in-ui.md); was `/forge-architect`) | brain, `projects/<name>/roadmap.md`, prior initiatives, `_architect/<sid>/answers.json` | `_queue/pending/INIT-*.md` + roadmap rows (only on explicit operator approve) |
| Review feedback & merge | `/forge-review <id>` | the project-repo PR + initiative branch | PR feedback for the review agent to process, OR the operator merges the PR in GitHub (which closes review) |
| Reflection feedback | `/forge-reflect <id>` | `_logs/<id>/user-questions.md` | `_logs/<id>/user-feedback.md` |

Why this matters: the trafficGame arc blurred autonomous forge with
hand-directed work because the human moments had no clean surface — the
architect was hand-loaded "Path-B", review verdict defaulted to
auto-approve, and reflection feedback was a file the operator had to
know to write. Slash commands make each moment **explicit, in the
operator's context, and impossible to silently auto-satisfy**. The
production system must therefore have NO auto-approve verdict path and
NO bench-simulator wired into a live cycle; simulators belong only to
benchmarks.

This composes with [[review-phase-target-design]] (the PR is the review
surface; `/forge-review` is how the operator engages it) and turns the
"architect is out-of-cycle, hand-run" honest-finding into a *designed*
property rather than an accident. It does not wire the architect into
`runCycle` — keeping it a human moment is the intent; the slash command
is its first-class home.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../../cycles/_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: blurred-lines + auto-approve footgun evidence.
- [`architecture.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/architecture.md) — §A out-of-cycle architect, §G operator-driven PR, §H simplification candidate 7.

## See also

- [[review-phase-target-design]] — `/forge-review` engages the PR surface defined there.
- [[forge-current-architecture-as-built]] — turns the out-of-cycle architect into a designed property.
- [[human-directed-work-as-initiatives]] — the failure mode clean human surfaces prevent.
- [[six-phases-of-forge]] — six phases of forge backed by a brain.
