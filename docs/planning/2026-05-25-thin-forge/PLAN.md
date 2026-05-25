# Plan — thin forge of synthetic guidance

> **Started:** 2026-05-25 from operator steer ("forge has accumulated
> too much synthetic guidance — let real merged cycles teach it").
> **Status:** drafting. Tier 0 (PM bias + bench rip) landed in commit
> 1524d01. Tiers 1–4 below await operator sign-off before execution.

## Thesis

Forge has accumulated **synthetic guidance** — hardcoded numerical
bounds, prescriptive prompt rules, balancing checklists, count-based
bench criteria — each added when a cycle went wrong, on the theory
that a tighter rule would prevent recurrence. Most of those rules
turned out to be diagnosis errors (the real cause was almost always
an observability gap, not a shape problem). Compounded over many
cycles, the guidance now actively *teaches the system* toward shapes
that look defensive rather than productive — most visibly, PM ended
up reliably producing 1-WI cycles even though forge's value-prop is
chunky-initiative decomposition.

The fix is **not** to write better guidance. The fix is to **rip the
synthetic guidance out** and let forge accumulate its own evidence
through brain themes attached to real merged cycles.

## What "synthetic guidance" looks like

| Pattern | Example |
|---|---|
| Magic number floor / ceiling | `minWorkItems = max(featureCount, 2)`; `Cap at ~5 features` |
| Specific-failure-shaped rule | "If a WI has more than 4 files / 3 ACs / 2 concerns, split it" |
| Bench rubric criterion that pins a number | `parallel_fraction_at_least: 0.3`; `work_item_count_in_range` |
| Prompt-injected "operator note" | "PM has been over-decomposing to hit 6 WIs by default; if your draft has ≥5 WIs, audit..." |
| Cycle-archive brain theme that overgeneralises one observation | `single-wi-single-pass-delivery.md`, `small-cycle-scope-ships-cleanly.md` |

The signature: **a rule the operator can't justify from durable
principles — only from "this one cycle went wrong".**

## What's already done (Tier 0 — landed 2026-05-25 in commit 1524d01)

- `benchmarks/` removed in full + scripts scrubbed from package.json + bench-score citations stripped from CLAUDE.md.
- `PmInvocationInput.minWorkItems/maxWorkItems/parallelFractionAtLeast` removed; PM prompt rewritten to "forge handles 1→N; brain-query for past WI shapes".
- Per-WI sizing rule (4 files / 3 ACs / 2 concerns) dropped.
- Architect SKILL "~5 features cap" replaced with brain-query guidance.
- 3 misleading 2026-05-25 themes deleted (`single-wi-single-pass-delivery`, `small-cycle-scope-ships-cleanly`, `autocommit-rate-worsening-multi-wi`).

## Remaining tiers

### Tier 1 — Skill prompts (medium impact, surgical)

Audit each SKILL.md + invocation prompt for synthetic guidance. The
candidates I'm aware of:

- **`skills/project-manager/SKILL.md`** — survived Tier 0 mostly because it already references brain-querying. Re-read for residual "rule of N" language.
- **`skills/developer-unifier/SKILL.md`** — likely contains iteration caps + write-skeleton-first nudges that were diagnostic fixes for specific wedges. The 2026-05-25 commits `3eab681`, `e06ff92`, `261fe47` all bumped caps + added nudges — review each for whether the underlying wedge has a real fix.
- **`skills/developer-ralph/SKILL.md`** — same shape audit.
- **`skills/architect/SKILL.md`** — Tier 0 dropped the "~5 features cap"; re-read the Process section for residual prescriptions.
- **`skills/reflector/SKILL.md`** — check for "always produce N themes" or similar.
- **`orchestrator/dev-invocation.ts`, `unifier-invocation.ts`, `reflector-invocation.ts`** — the prompt-building code. Look for hardcoded numbers, ordered lists of rules.

Rule of thumb for each rule found: **can it be justified from a durable principle?** If yes, keep. If "we added it after cycle X wedged", drop or replace with brain-query.

### Tier 2 — Orchestrator-side enforcement (high impact, careful)

The orchestrator currently enforces several things via runtime checks that started as diagnostic patches:

- **`orchestrator/failure-classifier.ts`** — currently maps to `transient | terminal`. Already minimised in 2026-05-24's slim-orchestrator move. Re-audit anyway.
- **`orchestrator/dev-invocation.ts` per-WI gate-tightening (`requiredPaths` etc.)** — defensible (catches the false-pass pattern from real cycles). Keep but document the underlying principle ("a quality gate that passes on iteration 0 is by definition not exercising the WI's acceptance").
- **`orchestrator/scheduler.ts` preserveWorktree set** — recently extended in `ce4e40a` for `'failed'`. Defensible (lets operator salvage). Keep.
- **`loops/ralph/runner.ts` iter-0 must-fail check** — defensible (same principle as above). Keep. (Bug #3 from operator's recent note is about how this is *emitted*, not whether it should exist.)
- **`loops/ralph/stop-conditions.ts` wedged-detection window** — currently `wedgedNoProgressIterations: 3` default. This is a magic number; should be derived from observed wedge patterns or made fully agent-controlled.

### Tier 3 — CLAUDE.md (low impact, signal-clarifying)

- The "Always do / Ask first / Never do" lists in CLAUDE.md are a mix of durable principles and diagnostic-of-the-day rules. Re-read each bullet against the "can the rule be justified from a durable principle" test.
- Tier 0 already dropped the bench-anchored "Status of the scaffold". Re-check the rest of CLAUDE.md for similar bench-anchored claims.

### Tier 4 — Brain themes audit (split into a separate plan)

Operator decision (2026-05-25): Tier 4 becomes its own plan once
Tiers 1–3 land. The brain structure has grown organically over many
cycles and warrants a holistic audit, not just spot-deletes. The new
plan will live at `docs/planning/<date>-brain-audit/PLAN.md` and
should cover:

- **Structural audit** — directory layout (forge themes / project
  themes / `_raw/cycles/` / `graphify-out/`), naming conventions,
  retention policy. Has it accumulated dead structure? Is the
  three-layer Karpathy wiki shape still holding?
- **Content audit** — which themes overgeneralise a single observation,
  which ones telegraph defensive shapes, which ones are stale because
  the underlying behaviour has changed. Tier 0 dropped 3; there are
  likely more.
- **Reference integrity** — sibling-theme back-refs, raw-cycle
  citations, INDEX.md state.

Don't delete themes that record real defects fixed (e.g., the
autocommit-rate themes are real evidence). Delete only the ones whose
*generalisation* was wrong.

## Anti-goals (what NOT to do)

- **Don't replace the synthetic guidance with new synthetic guidance.** The replacement for "Cap at ~5 features" is brain-query for past successful initiative shapes, NOT "Cap at ~10 features".
- **Don't delete the durable principles.** Examples that stay:
  - "Consult the brain before starting work" (PM + architect + reflector only).
  - "Emit structured events to the JSONL event log on every skill invocation."
  - "Use git worktrees for parallel work units."
  - "Don't re-invent a job queue / worker pool / process isolator" (ADRs 011–013).
  - "Spawn agents as Claude Code skills via the SDK, not CLI subprocesses."
  - "Use markdown artifacts to flow data between phases."
  - The five PRINCIPLES.md items.
- **Don't churn brain themes that record raw cycle observations.** The cycle archives under `brain/_raw/cycles/` are raw data — keep all. The themes that synthesise interpretations are what to audit.

## Open question — bench replacement (when, not whether)

Tier 0 removed the benches outright; they will need a replacement
eventually. The right shape is unclear and intentionally deferred:

- **Derive bench fixtures from `brain/_raw/cycles/*.md` automatically** —
  pick the last N successful merged cycles, replay their PM input
  through the current PM, check the output looks similar. Anchors the
  bench on real cycle artifacts.
- **Drop per-phase benches entirely** — rely on real merged cycles as
  the only signal, with a `forge bench` CLI that just lists "what
  shipped" / "what wedged" across recent cycles.
- **Keep an e2e-only bench** — one fixture, one real initiative, full
  cycle — as a regression-detection canary.
- **Rebuild-from-scratch self-bench** (operator idea, 2026-05-25): use
  [`parsoFish/claude-harness`](https://github.com/parsoFish/claude-harness)
  (or a snapshot of it) as the reference. Have forge rebuild the
  project from a clean slate through the full cycle pipeline; judge
  the resulting tree against the reference. Expensive (a single run
  is a 10+ cycle / multi-hour journey) but high-signal: it directly
  measures whether forge can take a known set of operator inputs and
  reproduce a known-good output. Could be the load-bearing feedback
  loop for forge-itself updates — if a forge change degrades the
  rebuild, the change regressed something real.

  Open sub-questions: how to score the resulting tree (structural
  diff? test-pass parity? subjective Opus-judge?); how to seed the
  initial roadmap deterministically; whether to use the public repo
  or a frozen snapshot; whether to run it on every forge PR or
  weekly. Worth a dedicated planning pass once the thinning is done.

This is a Tier 5 decision; not blocking the current thinning pass.

## Execution proposal

Wait for operator sign-off on each tier separately. Don't batch them
into one PR — each tier is a coherent unit of work that can be
verified independently. After each tier lands, run a real cycle on
`claude-harness` (or another project) to confirm the system behaves
correctly without the guidance that was removed.
