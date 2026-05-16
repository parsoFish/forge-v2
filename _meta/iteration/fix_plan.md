# fix_plan — the loop worklist

> One unit per line-item. `[ ]` = open, `[~]` = in-progress, `[x]` =
> done (closure-check verifies; ticking here is not "done"). Work in
> dependency order. Every code unit: `tsc` + `npm test` green before
> commit. Maps to user stories (US) / closure goals (G) / findings (I).

## Phase 0 — harness + objective gate
- [x] 0.1 `_meta/iteration/PLAN.md` (confirmed plan)
- [x] 0.2 `_meta/iteration/fix_plan.md` (this file)
- [x] 0.3 `_meta/iteration/coverage-matrix.md` — every US criterion → a check
- [x] 0.4 `_meta/iteration/closure-check.ts` — tiered objective gate (fast|full)
- [x] 0.5 `_meta/iteration/{PROMPT,AGENT}.md` (loop.ts removed as surface; loops/ralph/runner.ts is the documented unattended-resume engine; in-session driving = the loop)

## Phase 1 — zero-risk removals (pure deletion; no behaviour change) — US-7.1/7.2, G3
- [x] 1.1 delete `validateFilesInScopeAgainstWorktree` + its tests (`orchestrator/work-item.ts`, `work-item.test.ts`)
- [x] 1.2 remove `pm-hallucinated-paths` mode end-to-end (`orchestrator/failure-classifier.ts` + tests)
- [x] 1.3 remove dead `event_type:'cost'` (`orchestrator/logging.ts`; check `metrics.ts`)
- [x] 1.4 delete `loops/_adapters/` entirely
- [x] 1.5 remove unread `ForgeConfig.models` (+ `forge.config.json.example`, ADR-009 mention)
- [ ] 1.6 delete `benchmarks/e2e/scoring.ts` + e2e fixture-as-scored-unit; keep only plumbing
- [x] 1.7 remove CLI stub verbs `forge brain query`, `forge bench` (+ help text)

## Phase 2 — doc/code parity & brain-read policy — G3, G7, US-2.*
- [x] 2.1 strip brain-gate text from `loops/ralph/PROMPT.md.tmpl`, `AGENT.md.tmpl`
- [x] 2.2 rewrite `skills/developer-ralph/SKILL.md` + `skills/reviewer/SKILL.md` to match emitted events + brain-read policy
- [x] 2.3 update ADR-010, `PRINCIPLES.md` P4, CLAUDE.md brain-first rule + status section
- [x] 2.4 update ADR-011 to real orchestrator LOC + rationale
- [x] 2.5 remove stale `assertBrainConsulted`/removed-gate comments & docstrings
- [x] 2.6 reconcile `ARCHITECTURE.md` to as-built; link the snapshot

## Phase 3 — consolidation/simplification — US-7.1, §H
- [x] 3.1 extract PR/merge from `runReviewer` → `orchestrator/pr.ts`
- [x] 3.2 one notify sink (thread resolved NotifyConfig through `runReviewer`)
- [x] 3.3 verify single coupling authority (`detectHiddenCoupling`)
- [x] 3.4 split files >800 LOC (`cycle.ts`, `demo.ts`, `scheduler.ts`) behaviour-preserving
- [x] 3.5 retire `pm-stale-context` (verify unreachable → delete)

## Phase 4 — benchmark fidelity — US-6.1, G11
- [x] 4.1 PM bench `sdk.ts`: cwd→worktree, budget 0.75→2.5
- [x] 4.2 review-loop bench: drop `brainConsulted` 0.10; real `runReviewer` path
- [ ] 4.3 re-run all per-phase benches; record in `brain/log.md`; assert no false-colour

## Phase 5 — chained benchmark — US-6.2, G12
- [ ] 5.1 lift `layerBrain`→`benchmarks/_lib/brain-mask.ts`; move gh-shim + `reconstructGateStateFromEventLog` to `_lib`
- [ ] 5.2 `benchmarks/chained/` sequencer: seed→architect-bench→cpSync→runCycle→fan-out to existing per-phase `caseScore`; `--source=chained`; pre-merge `.forge/` snapshot
- [ ] 5.3 assert no chained-only rubric/fixture exists

## Phase 6 — review-phase redesign — US-1.3/3.2/5.2/5.3, C6, G1/G8/G9/G10
- [ ] 6.1 dev-loop pushes initiative branch to origin per WI; invariant origin==local, main==merge-base
- [ ] 6.2 remove auto-merge from unattended path; `mergePullRequest` unreachable w/o operator action
- [ ] 6.3 review = holistic intent gate that may spawn dev-loops; produces demo-embedded PR then stops
- [ ] 6.4 reflection only on GitHub-confirmed merge; `done/`⇒MERGED; partial merges flagged
- [ ] 6.5 closure aligns local↔remote (ff main, prune branch)

## Phase 7 — human interaction as slash commands — US-3.1, Q4 resolved
- [ ] 7.1 create `/forge-architect`, `/forge-review <id>`, `/forge-reflect <id>` (own session, file handoff)
- [ ] 7.2 remove production auto-approve `defaultGetVerdict`; simulators bench-only
- [ ] 7.3 document architect as intentionally out-of-cycle (not a gap)

## Phase 8 — contract preflight + origin tagging — US-4.1, C1–C6, G6, closes I6
- [ ] 8.1 implement C1–C6 preflight (decline with failing clause named)
- [ ] 8.2 manifest `origin: architect|human-directed`; metrics + reflector separate cohorts
- [ ] 8.3 write ADR-017 (forge↔project contract)

## Phase 9 — closure + human presentation
- [ ] 9.1 regenerate as-built Mermaid snapshot from changed code; consistency check
- [ ] 9.2 refresh user stories + traceability; coverage-matrix → 100%
- [ ] 9.3 human "state of forge" report (visual architecture + green closure report)
- [ ] 9.4 final brain reflection (themes + brain/log.md); update CLAUDE.md status
- [ ] 9.5 `closure-check --tier=full` exits 0 → loop exits
