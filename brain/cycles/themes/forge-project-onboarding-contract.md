---
title: >-
  The forge↔project contract — six clauses a project must meet for unattended
  progress
description: >-
  Empirically derived from what trafficGame needed before forge could run it
  unattended. C1 fast gate, C2 scratch hygiene, C3 decomposed source, C4
  machine-readable arch context, C5 honoured locked-core mandates, C6
  satisfiable merge model (the open clause).
category: decision
keywords:
  - contract
  - onboarding
  - preflight
  - quality-gate
  - gitignore
  - decomposition
  - roadmap
  - locked-core
  - merge-model
  - C1-C6
  - automated-cycles
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-16T00:00:00.000Z
related_themes:
  - merge-boundary-stacked-initiative-failure
  - forge-current-architecture-as-built
  - file-based-state-machine
  - quality-gates-orchestrator-verified
---

# The forge↔project contract

For forge to progress a project toward **more automated cycles with less
hand-holding**, the project must satisfy a contract. This is not
aspirational — each clause is the generalisation of a specific
trafficGame blocker that had to be fixed before unattended runs worked.

- **C1 — Fast, trustworthy quality gate.** One command, deterministic,
  green at HEAD, fast (≈≤10s). trafficGame's 18k-LOC/106-file suite
  broke the per-iteration gate until the Phase-1 rip-and-redraw.
- **C2 — Scratch hygiene.** Project `.gitignore` excludes `.forge/`,
  `AGENT.md`, `PROMPT.md`, `fix_plan.md`. Until it did, every cycle
  committed forge scratch into the PR and confused the reviewer.
- **C3 — Decomposed source under the project's own size norm.** Oversized
  god-files (Game.ts at 1,732 LOC) make work items collide on shared
  files; Phase-2/3 extractions were prerequisites for clean parallel WIs.
- **C4 — Machine-consumable architecture context.** A `roadmap.md` plus
  seeded brain themes. Without queryable structure (and with the F-37
  `cwd` bug) the architect/PM hallucinated paths.
- **C5 — Locked-core mandates the harness honours.** The project's
  CLAUDE.md constraints (e.g. trafficGame: user owns git, never modify
  tests to pass, per-map calibrated thresholds) must be respected;
  forge had to change to commit-not-reset to honour git ownership.
- **C6 — A satisfiable merge model (OPEN).** Either initiatives
  serialize behind their base merge, or forge enforces non-stacked
  branches before `gh pr merge`. Today neither holds — this is the
  proximate cause of "`done/` ≠ merged" and the live blocker to
  unattended operation.

This contract is the operator's durable deliverable from the trafficGame
arc. It should become a written preflight (closure goal G2) and,
because it is load-bearing, a candidate ADR-017. C1–C5 are met by
trafficGame today; C6 is not met by forge.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: the structural-prerequisite evidence.
- [`retro.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/retro.md) — §3 contract derivation, §6 closure goals G2/G6.

## See also

- [[merge-boundary-stacked-initiative-failure]] — C6, the open clause.
- [[forge-current-architecture-as-built]] — what the contract is enforced against.
- [[file-based-state-machine]] — file-based state machine for queue management.
- [[quality-gates-orchestrator-verified]] — C1's enforcement mechanism.
