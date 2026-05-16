# Coverage matrix — US/G → objective check

> `closure-check.ts` parses the table below. One row per acceptance
> obligation. `kind` ∈ `cmd | grep-absent | grep-present | file-absent |
> file-present | loc-max | pending`. `tier` ∈ `fast | full`. A row
> passes per its kind:
> - `cmd`     — `arg` is a shell command; exit 0 = pass.
> - `grep-absent`  — `arg` = `PATTERN :: GLOB`; pass iff 0 matches.
> - `grep-present` — `arg` = `PATTERN :: GLOB`; pass iff ≥1 match.
> - `file-absent` / `file-present` — `arg` = path.
> - `loc-max`  — `arg` = `N :: GLOB`; pass iff no matched file > N lines.
> - `pending`  — always unmet (work not yet done); convert when landed.
>
> The loop is "done" only when every row at the running tier passes.

| id | obligation | kind | arg | tier |
|----|------------|------|-----|------|
| BUILD | tsc strict clean | cmd | `npm run build` | fast |
| TEST | unit suite green | cmd | `npm test` | fast |
| G3-a | dead validator removed | grep-absent | `validateFilesInScopeAgainstWorktree :: orchestrator` | fast |
| G3-b | dead classifier mode removed | grep-absent | `pm-hallucinated-paths :: orchestrator` | fast |
| G3-c | dead event type removed | grep-absent | `'cost' :: orchestrator/logging.ts` | fast |
| G3-d | adapters placeholder removed | file-absent | `loops/_adapters` | fast |
| G3-e | unread config field removed | grep-absent | `models?: :: orchestrator/config.ts` | fast |
| G3-f | no stale assertBrainConsulted refs | grep-absent | `assertBrainConsulted :: orchestrator loops skills` | fast |
| G3-g | no brain-gate threat in templates | grep-absent | `brain-first gate :: loops/ralph` | fast |
| G12-a | no bespoke e2e rubric | file-absent | `benchmarks/e2e/scoring.ts` | fast |
| G4 | single coupling authority (detectHiddenCoupling only) | grep-present | `detectHiddenCoupling( :: orchestrator/cycle.ts` | fast |
| G9 | no auto-merge reachable unattended | pending | phase-6 | full |
| SIMPL-LOC | no source file > 800 LOC | loc-max | `800 :: orchestrator loops` | fast |
| CLI-1 | brain-query stub verb removed | grep-absent | `(skeleton) brain-query :: orchestrator/cli.ts` | fast |
| CLI-2 | bench stub verb removed | grep-absent | `Run via: npm run bench :: orchestrator/cli.ts` | fast |
| US-2.3 | brain index cache invalidated or documented | pending | phase-2 | fast |
| G7 | doc/code parity (ARCHITECTURE/ADR-010/PRINCIPLES reconciled) | pending | phase-2 | fast |
| US-7.1-notify | one notify sink (no hardcoded literal) | grep-absent | `desktop: true, webhook_url: null :: orchestrator/cycle.ts` | fast |
| US-1.3-pr | PR/merge extracted to orchestrator/pr.ts | file-present | `orchestrator/pr.ts` | fast |
| G11 | per-phase benches, no false-colour | pending | phase-4 | full |
| G12-b | chained bench scores via existing rubrics only | pending | phase-5 | full |
| G1 | done/ ⇒ PR MERGED | pending | phase-6 | full |
| G8 | dev-loop close: origin==local, main==merge-base | pending | phase-6 | full |
| G10 | reflection only on confirmed merge | pending | phase-6 | full |
| US-3.1 | three slash commands exist | pending | phase-7 | fast |
| US-4.1 | C1–C6 preflight implemented | pending | phase-8 | fast |
| G6 | manifest origin tag + cohort split | pending | phase-8 | fast |
| ARCH-FRESH | as-built snapshot regenerated & consistent | pending | phase-9 | full |
| COVERAGE | every US criterion mapped & green | pending | phase-9 | full |
