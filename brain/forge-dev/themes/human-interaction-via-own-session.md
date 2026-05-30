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
updated_at: 2026-05-30T00:00:00.000Z
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
> (`questions.json` ↔ `answers.json`).
>
> **Amended again 2026-05-30 ([ADR 021](../../../docs/decisions/021-local-review-and-unified-demo.md)).**
> The **review** moment also moved *into the forge UI* (the `/review/[cycleId]`
> screen renders a structured `demo.json` + the verdict form) to tighten
> iteration. The same load-bearing property holds: the PR is still created +
> merged on approve, and there is **no auto-approve** — the operator's verdict
> gates the merge.
>
> **Amended again 2026-05-30.** The **reflection** moment also moved into the
> forge UI (the `/reflect/[cycleId]` screen renders the reflector's Stage-2
> `user-questions.json` and writes `user-feedback.md`). All three human moments
> now run in-UI on dedicated screens; the invariant below — explicit,
> operator-initiated, impossible to silently auto-satisfy — holds on every one
> (reflection still only writes the brain after the operator submits feedback).
>
> **Amended again 2026-05-30 ([ADR 023](../../../docs/decisions/023-ui-sole-operator-surface.md)).**
> The forge **UI is now the *sole* operator interaction surface** — the
> slash-command / PR-comment / CLI verdict mechanism is retired (not the
> invariant). The verified-dead parts are removed: the PR-comment poller
> (`review-router`), the PR-comment verdict provider (`pr-verdict`), the
> never-invoked `getVerdict` provider seam, and the `/forge-review` command. The
> parity-covered fallbacks were then retired (2026-05-30 follow-up — the in-UI
> screens + bridge are the single write-path): `/forge-reflect` (+
> `forge-reflect-cli`), `forge send-back`, and the architect out-of-cycle path
> (`/forge-architect` + the dead `architect-commit.ts`; the in-UI runner is
> canonical, with `skills/architect/SKILL.md` as its prompt). The only live
> fallback left is `forge review --approve` — load-bearing (`verify-cycle.mjs`
> auto-approves through it). **Load-bearing property is unchanged and easier to
> guarantee**: one write-path per moment satisfies its gate (no auto-approve, no
> simulator in production).

Forge has exactly **three deliberate human interaction moments**. The
operator's direction: each is performed in the operator's **own Claude
session** (CLI or VSCode extension) — not a forge-spawned sub-agent and
not a bench simulator standing in for production. The cleanest
implementation is a **slash command** per moment.

| Moment | Surface | Reads | Writes / effect |
|---|---|---|---|
| Roadmap / architect | **in-UI architect** ([ADR 020](../../../docs/decisions/020-architect-in-ui.md); was `/forge-architect`) | brain, `projects/<name>/roadmap.md`, prior initiatives, `_architect/<sid>/answers.json` | `_queue/pending/INIT-*.md` + roadmap rows (only on explicit operator approve) |
| Review feedback & merge | **in-UI review screen** ([ADR 021](../../../docs/decisions/021-local-review-and-unified-demo.md); was `/forge-review` on the PR) | the cycle's structured `demo.json` + status | verdict (approve → PR merged on close / send-back) submitted locally; no auto-approve |
| Reflection feedback | **in-UI reflect screen** (2026-05-30; was `/forge-reflect`) | `_logs/<id>/user-questions.json` | `_logs/<id>/user-feedback.md` (then reflector reruns) |

Why this matters: the trafficGame arc blurred autonomous forge with
hand-directed work because the human moments had no clean surface — the
architect was hand-loaded "Path-B", review verdict defaulted to
auto-approve, and reflection feedback was a file the operator had to
know to write. Slash commands make each moment **explicit, in the
operator's context, and impossible to silently auto-satisfy**. The
production system must therefore have NO auto-approve verdict path and
NO bench-simulator wired into a live cycle; simulators belong only to
benchmarks.

This composes with [[review-phase-target-design]] and turns the
"architect is out-of-cycle, hand-run" honest-finding into a *designed*
property. The original slash-command home for each moment is now,
per ADR 020/021/023, an in-UI screen for all three moments (the UI is
the sole interaction surface) — but the **impossible-to-auto-satisfy**
invariant above is the load-bearing part and is preserved on every surface.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../../cycles/_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: blurred-lines + auto-approve footgun evidence.
- [`architecture.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/architecture.md) — §A out-of-cycle architect, §G operator-driven PR, §H simplification candidate 7.

## See also

- [[review-phase-target-design]] — `/forge-review` engages the PR surface defined there.
- [[forge-current-architecture-as-built]] — turns the out-of-cycle architect into a designed property.
- [[human-directed-work-as-initiatives]] — the failure mode clean human surfaces prevent.
- [[six-phases-of-forge]] — six phases of forge backed by a brain.
