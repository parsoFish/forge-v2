# Autonomous Iteration Plan — drive forge to "done" (CONFIRMED 2026-05-16)

> Confirmed by the operator with two clarifications, applied throughout:
> (1) **remove in all cases where possible** (simplification overrides
> "keep" on every open decision); (2) **the architect stays a human
> moment** (`/forge-architect`; never wired into `runCycle`).
> This file is the executable spec. The loop reads `fix_plan.md` (the
> worklist) and is "done" only when `closure-check.ts` exits 0.

## Mission

Iterate on the forge codebase until ALL hold:
1. Every user story in `docs/forge-user-stories.md` is faithfully
   implemented (verified via `_meta/iteration/coverage-matrix.md`).
2. Forge is validated through benchmarks (per-phase, no
   false-green/false-red; chained; plus `tsc` strict + unit suite).
3. A human-presentable, visual (Mermaid) as-built architecture is
   regenerated from the changed code and verified consistent.

## Guardrails (non-negotiable)

- **External dev loop on the forge repo.** This is NOT forge's
  orchestrator scheduling forge as a managed project. Respect the
  `forge-never-self-modifies` brain theme.
- **Principle 1 — no hand-rolling.** The loop engine is the existing
  Ralph pattern (`loops/ralph/runner.ts` + `claude-agent.ts`); the
  gate is `closure-check.ts`. No new loop engine.
- **Simplification overrides.** Prefer deletion. Adding surface to pass
  a story is a defect to redesign. No feature flags / fallback paths.
- **Every change is gated.** `tsc` strict + `npm test` green before any
  commit. Conventional commits, one concern per commit.
- **Cost-aware.** Per-iteration gate = `closure-check --tier=fast`
  (static + unit). Benches (`--tier=full`) run only at phase/closure
  boundaries.

## Resolved decisions (remove-everywhere + architect-human)

1. `loops/_adapters/` → **delete**.
2. CLI stubs `forge brain query`, `forge bench` → **remove the verbs**.
3. ADR-011 → **update to real LOC**; additionally **remove** dead
   orchestrator surface (do not relocate invocation contracts unless it
   net-reduces surface).
4. `pm-stale-context` → **retire** (remove) once its emit path is
   verified unreachable; if still reachable, make it reachable-and-named
   or delete the dead arm — default delete.
5. Architect → **stays a human moment** via `/forge-architect`; NOT
   wired into `runCycle`; documented as intended, not a gap.

## Source-of-truth inputs (acceptance lives here)

- `_logs/2026-05-16_trafficgame-arc-reflection/retro.md` — I1–I6,
  G1–G12, C1–C6.
- `.../architecture.md` & `docs/architecture/as-built-snapshot-2026-05-16.md`
  — as-built §A–F, review redesign §G, simplification §H.
- `.../benchmark-alignment.md` — drift §A, chained design §C, G11/G12.
- `docs/forge-user-stories.md` — the 8 epics (acceptance source).
- Brain decisions/antipatterns/reference themes listed in that retro.

## Phases (dependency-ordered; see fix_plan.md for atomic units)

`0 → 1 → {2,3,4,8} → 5(needs 1.6+4) → 6(needs 3.1+2) → 7(needs 6) → 9`

- **0** Harness + objective closure gate + coverage matrix.
- **1** Zero-risk removals (#1–#7) — pure deletion, no behaviour change.
- **2** Doc/code parity & brain-read-policy reconciliation (G3,G7).
- **3** Consolidation/simplification: extract `orchestrator/pr.ts`,
  one notify sink, single coupling authority, files ≤800 LOC,
  retire `pm-stale-context`.
- **4** Benchmark fidelity (G11): PM cwd/budget; review-loop drop
  `brainConsulted` + real `runReviewer` path.
- **5** Chained benchmark (G12): `_lib` plumbing lift; `benchmarks/chained/`
  seed→architect→runCycle→fan-out to existing rubrics.
- **6** Review-phase redesign (C6,G1,G8,G9,G10): branch synced
  local↔remote, no auto-merge, holistic gate may spawn dev-loops,
  reflection on confirmed merge, closure aligns local↔remote.
- **7** Slash commands (`/forge-architect`, `/forge-review`,
  `/forge-reflect`); remove production auto-approve verdict; simulators
  bench-only; architect stays human.
- **8** Contract preflight (C1–C6) + manifest `origin` tag (G6, closes
  I6) + ADR-017.
- **9** Regenerate visual as-built snapshot; refresh stories +
  coverage→100%; human "state of forge" report; final brain reflection;
  loop exits.

## Definition of done (loop stop condition)

`node --experimental-strip-types _meta/iteration/closure-check.ts
--tier=full` exits 0: tsc strict clean · unit suite green · every
per-phase bench ≥ threshold with no false-green/false-red · chained
bench green with no bespoke rubric · G1–G12 true · coverage-matrix 100%
· no file >800 LOC · doc/code-parity grep empty · architecture snapshot
regenerated & consistent. The loop cannot self-declare done.

## Risks

HIGH: scope/cost runaway (mitigate: phased DAG, fast-tier per iteration,
budgets, wedged→human escalation). HIGH: refactor regressions (full
suite gates every commit; Phase 6 behind chained bench). HIGH:
self-modification confusion (guardrail above). MED: gate-gaming
(G11 forbids false-green; parity grep symbol-specific). LOW: slash
command + Mermaid wiring.
