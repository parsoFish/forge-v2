# ADR 017 — The forge↔project contract (C1–C6 preflight)

**Status:** Accepted
**Date:** 2026-05-17

## Context

Forge v2 is designed to progress a project toward *more automated cycles
with less hand-holding*. The trafficGame arc (April–May 2026) was the
first sustained attempt to run an external project unattended, and it
proved that **forge cannot progress an arbitrary project** — the project
must first satisfy a set of structural properties. Each property is the
generalisation of a specific trafficGame blocker that had to be fixed
before unattended runs worked (full evidence:
`_logs/2026-05-16_trafficgame-arc-reflection/retro.md` §3; durable record:
brain theme [`forge-project-onboarding-contract`](../../brain/forge/themes/forge-project-onboarding-contract.md)):

- trafficGame's ~18k-LOC / 106-file test suite broke the per-iteration
  quality gate until it was ripped down to a fast unit suite.
- The project `.gitignore` did not exclude forge scratch, so every cycle
  committed `.forge/` / `AGENT.md` / `PROMPT.md` / `fix_plan.md` into the
  PR and confused the reviewer (W4 v3/v4).
- `Game.ts` at 1,732 LOC made work items collide on shared files; five
  parallel extractions were a prerequisite for clean parallel WIs.
- Without a `roadmap.md` and a seeded brain sub-wiki (and with the F-37
  `cwd` bug) the architect/PM hallucinated paths.
- The project's CLAUDE.md owns git and forbids tampering with tests to
  pass; forge had to change (commit-not-reset) to honour it.
- The "`done/` ≠ merged" defect proved the merge model was not
  satisfiable until the Phase-6 review redesign removed auto-merge.

This contract is the operator's durable deliverable from the trafficGame
arc. The retro recorded it as closure goal **G2** (contract sufficiency)
and explicitly flagged it as "load-bearing, a candidate ADR-017." It is
also the precondition that makes the *autonomous* operating mode
well-defined — the counterpart to G6's origin tagging
([brain theme `human-directed-work-as-initiatives`](../../brain/forge/themes/human-directed-work-as-initiatives.md)),
which separates autonomous cycles from hand-directed project surgery so
"did forge get more autonomous" stays answerable.

## Decision

A project must satisfy the **six-clause forge↔project contract** before
forge attempts to progress it unattended. The contract is enforced by a
written, checkable preflight: `forge preflight <project>`
([`orchestrator/preflight.ts`](../../orchestrator/preflight.ts), wired in
[`orchestrator/cli.ts`](../../orchestrator/cli.ts)). The preflight is
pure (`runPreflight()` returns a structured report; the CLI renders it and
sets the exit code) so an unattended caller can gate on it.

| Clause | Requirement | Enforcement | Failure mode |
|--------|-------------|-------------|--------------|
| **C1** | Fast, trustworthy quality gate | **HARD** | One deterministic test command exists (`package.json` `test` script or a `.forge/quality_gate_cmd` sidecar — mirrors the manifest's `quality_gate_cmd` field). Heuristic for "plausibly fast": a single command (no `&&`/`;`/`\|`/`\|\|` chaining) that is not a primarily-e2e umbrella (`playwright`/`cypress`/`e2e`/`integration` as the *primary* command — the 18k-LOC-suite smell). We do not run it (could be minutes / require deps); the check is structural. |
| **C2** | Scratch hygiene | **HARD** | Project `.gitignore` excludes `.forge/`, `AGENT.md`, `PROMPT.md`, `fix_plan.md`. |
| **C3** | Decomposed source under the project's size norm | advisory | No source file egregiously over the size norm. Default ceiling **800 LOC** (the same ceiling forge holds on its own tree — coverage-matrix `SIMPL-LOC`; a defensible project default). Files ≥ **1600 LOC** (2×) are flagged as god-file class. Advisory, never fatal: the operator may have a justified exception and the PM's `detectHiddenCoupling` is the real runtime guard. |
| **C4** | Machine-readable architecture context | **HARD** | A `roadmap.md` in the project root **and** a brain sub-wiki at `brain/projects/<name>/profile.md`. |
| **C5** | Locked-core mandates the harness honours | advisory | A constraints doc exists (`CLAUDE.md` / `AGENTS.md` / `.forge/constraints.md` / `CONSTRAINTS.md`). Advisory because file presence cannot *prove* the harness honours the constraints — it only proves the operator declared them. |
| **C6** | A satisfiable merge model | advisory | **Forge-side-satisfied** post-Phase-6: the review phase produces a demo-embedded PR and STOPS; the operator merges in GitHub; there is no auto-merge ([ADR 011 path](./011-unattended-scheduler.md), Phase-6 review redesign). The only project-side requirement is a GitHub remote so a PR surface exists; the preflight states the clause is forge-side-satisfied and checks the remote. |
| **BRAIN** | Brain freshness (themes cite live source paths) | advisory | Added 2026-05-18. Scans `brain/projects/<name>/themes/*.md` for `src/`/`tests/` paths that no longer exist in the project tree. A theme that contradicts the code (left stale by a by-hand change that skipped the reflection phase) silently poisons the PM/architect (they read the brain first) — this surfaces it *before* a cycle. WARN-only: themes legitimately reference history, and the operator/reflection judges. Known coarse false-positive: a theme that *documents a deletion* must name the deleted path — phrase such references without an `src/…`-shaped token. Pairs with the `pm-thrash-no-converge` failure mode (capped + degenerate WIs ⇒ NOT auto-retried; recommends running `forge preflight` + sharpening the manifest). |

Hard clauses (C1/C2/C4) fail the preflight and exit non-zero — forge
**declines**, naming the failing clause. Advisory clauses (C3/C5/C6 +
BRAIN) surface as warnings and never flip the verdict, because their
checks are heuristic (C3), unprovable by inspection (C5), structurally
owned by forge rather than the project (C6), or a freshness signal the
operator judges (BRAIN). The contract proper remains the six C-clauses;
BRAIN is an added advisory freshness check, not a seventh contract
clause.

This was empirically validated: `forge preflight trafficGame` reports
**6/6 PASS** against the real project, confirming C1–C5 are met by
trafficGame today and C6 is now forge-side-satisfied (retro §3 predicted
exactly this — C1–C5 met, C6 the previously-open clause now closed by the
review redesign).

## Consequences

**Positive:**
- The autonomous operating mode is now *well-defined*: a project either
  passes the contract or forge declines with an actionable reason, rather
  than failing opaquely mid-cycle (closes the G2 ambiguity).
- The preflight is unattended-gateable (non-zero exit on hard failure), so
  the scheduler / an operator script can refuse a non-conformant project
  before burning SDK cost on a cycle that cannot converge.
- Each clause traces to concrete trafficGame evidence, so the contract is
  not aspirational — it is the minimal set that was actually required.
- Pure core + thin CLI wrapper keeps it testable (14 unit tests) and
  consistent with the orchestrator's invocation-contract pattern.

**Negative / accepted trade-offs:**
- C1's "fast" check is structural, not behavioural — a single
  non-e2e command could still be slow (e.g. a large unit suite). Accepted:
  running it here is infeasible (deps/time) and the per-iteration gate's
  own timeout is the runtime backstop. The heuristic catches the failure
  *class* trafficGame hit (umbrella e2e as the test command).
- C3/C5/C6 advisory means a project can pass the preflight with warnings
  and still hit friction. Accepted — making them hard would produce false
  declines (justified large files; constraints forge does honour but can't
  verify; the merge model forge itself owns). The warnings are surfaced
  prominently so the operator decides.
- The brain sub-wiki path is conventional (`brain/projects/<name>/`). A
  project whose name does not match its directory would fail C4 spuriously.
  Accepted — the same `<name>` convention is already load-bearing for the
  reflector's theme writes; fixing it in one place is out of scope here.

## Alternatives considered

- **No preflight — let cycles fail and classify the failure.** Rejected.
  The failure-classifier is reactive and burns a full cycle's SDK cost to
  discover a structural prerequisite a one-second check catches. The retro
  explicitly called for a *written* preflight (G2).
- **All six clauses hard.** Rejected — produces false declines on
  justified large files (C3), constraints forge honours but cannot prove
  by inspection (C5), and the merge model forge itself owns post-Phase-6
  (C6). A contract that cries wolf gets ignored.
- **Run the quality gate during preflight to measure real wall-time
  (C1).** Rejected — requires installing the project's deps and could take
  minutes; the preflight must be cheap and side-effect-free. The structural
  heuristic targets the exact failure class observed.
- **A `.forge/contract.yaml` the operator hand-fills.** Rejected
  ([PRINCIPLES.md §3](../../PRINCIPLES.md)) — bureaucratic and trust-based;
  the preflight inspects the project's *actual* state (`.gitignore`,
  `package.json`, brain, git remote), which cannot be gamed by a checklist.
- **Fold the preflight into `forge enqueue`.** Rejected — preflight is a
  project-level property checked once per project; enqueue is per-initiative.
  Coupling them would re-run the check needlessly and conflate two
  concerns. A standalone verb is the single-responsibility choice.

## References

- [`brain/forge/themes/forge-project-onboarding-contract.md`](../../brain/forge/themes/forge-project-onboarding-contract.md) — the C1–C6 contract, design of record.
- [`brain/forge/themes/human-directed-work-as-initiatives.md`](../../brain/forge/themes/human-directed-work-as-initiatives.md) — the blurred-lines antipattern; the origin tag (G6) is the cohort-separation sibling that makes the autonomous mode this contract gates measurable.
- `_logs/2026-05-16_trafficgame-arc-reflection/retro.md` §3 (C1–C6 derivation), §6 closure goals G2 (contract sufficiency) and G6 (origin tagging).
- [`docs/forge-user-stories.md`](../forge-user-stories.md) US-4.1 — the operator-facing requirement.
- [`orchestrator/preflight.ts`](../../orchestrator/preflight.ts) — the implementation; [`orchestrator/preflight.test.ts`](../../orchestrator/preflight.test.ts) — clause-by-clause tests.
- [ADR 011](./011-unattended-scheduler.md) — the unattended scheduler path the contract gates entry to.
- [ADR 014](./014-roadmap-format.md) — `roadmap.md` schema, the C4 artefact.
- [ADR 015](./015-work-item-format.md) — work-item schema; the manifest `origin` field (G6) is a sibling schema addition.
