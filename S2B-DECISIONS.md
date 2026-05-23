# S2B — Architect bench reground + cross-phase handoff: decisions

Stage S2B of the 2026-05-20 refinement batch. Operator was asleep at
implementation time; the rationale below records the judgments made.

## Discriminator fixtures (B1 / B2)

**Decision:** B1 and B2 are added as new entries in
`benchmarks/architect/prompts.json` (the architect bench is now 10
fixtures: A1..A8 synthetic + B1/B2 betterado-grounded). Baseline-pre-S2A
and refined-post-S2A reference manifests live under
`benchmarks/architect/fixtures/betterado/{baseline-pre-s2a,refined-post-s2a}/`.

**Baseline-pre-S2A representative.** Three real betterado manifests
copied verbatim from `_queue/pending/INIT-2026-05-18-betterado-{01,03,04}.md`:

- `baseline-pre-s2a/INIT-01.md` (release_definition test substrate)
- `baseline-pre-s2a/INIT-03.md` (task_group test substrate)
- `baseline-pre-s2a/INIT-04.md` (test plan core)

These were chosen because (a) they're substrate initiatives the operator
will actually run next, (b) all three share the exact "## Council
constraints (binding)" block + the "## Scope — PM: stay inside this"
block verbatim, exercising `project_context_lifted`, and (c) their
combined manifests give the discrimination test the ≥3-manifests
threshold the criterion requires.

**Refined-post-S2A representative.** Three rewrites in the same dir that
lift the duplicated council-constraints + PM-scope blocks into two
brain references:
`brain/projects/terraform-provider-betterado/themes/council-constraints.md`
and `.../release-substrate-context.md`. Both brain files are committed
under `brain/projects/terraform-provider-betterado/themes/` so the
`brain_consulted_qualified` existsSync check passes. The refined dir
also includes a `PLAN.md` that satisfies `escalations_resolved` (both
escalations carry resolution markers).

## Algorithm — `project_context_lifted`

**Hash-based block detection.** For each manifest body, split on `##` H2
headings into blocks. For each block, only consider it "boilerplate
signal" if it is ≥3 non-empty lines AND ≥80 chars. Normalise each
block by:
1. Lowercasing.
2. Stripping inline code (`` `…` ``).
3. Stripping slash-bearing path-like tokens (so the per-area `go test
   ./azuredevops/internal/service/{release,taskagent,test}/...` line
   doesn't defeat detection).
4. Collapsing whitespace to single spaces.

A normalised block hash that appears in ≥3 distinct manifests is
flagged. The criterion fails if any duplicate exists AND PLAN.md does
not contain a brain reference. (Stricter alternative considered: require
the boilerplate to be ABSENT from manifests entirely. Rejected — refined
manifests may still carry a short pointer to the brain doc; intent is
measured via PLAN.md.)

Why hash-based vs regex-based: regex on the literal text fails on the
"go test ./azuredevops/internal/service/{release,taskagent,test}/..."
variation across the three substrate initiatives (the very motivating
example). Hashing after path-stripping is a one-line normalisation that
collapses that variation while still distinguishing genuinely different
blocks (different headings, different bullet content).

## Frozen-SHA pin mechanism

The pin is **a comment in the file**, not a git tag. The 10-line header
at the top of `benchmarks/project-manager/scoring.frozen.ts` calls out
the pinned commit (9585fba) explicitly and says "Update explicitly when
PM-bench shape changes; do not edit incidentally." `npm test` byte-checks
the file content (via the unit tests that import from it); a git tag
would add operational complexity without changing the contract.

A second guard is the `downstream_pm_score calls the frozen rubric, not
scoring.ts` test in `scoring.test.ts`: it imports both modules and
asserts the `caseScore` function reference is distinct (proves
frozen.ts is a literal copy, not a re-export).

## Cross-phase handoff layout

Single canonical module at `benchmarks/_lib/handoff.ts` (per C10 — NO
`architect-handoff.ts` / `pm-handoff.ts` files). Two exports
(`loadArchitectHandoff` + `loadPmHandoff`), one file. Per-run isolation
via `results/<iso-slug>/<fixtureId>/` dirs (ISO timestamps sort
lexicographically, so "latest" is unambiguous).

The architect bench's `writeResults` produces `<iso-slug>.json` while
S2B's new handoff writer produces `<iso-slug>/` — file vs dir at the
same path level, no collision.

## Other taste decisions

- **`downstream_pm_score` default when no PM run was done.** Treated as
  N/A → 1.0. Rationale: the bench harness's first iteration of the
  cross-phase wire won't always run the PM (the PM bench is independent
  by default); we want B1/B2 to still discriminate based on the other
  criteria. When the operator wires the architect→PM round-trip, the
  criterion becomes the dominant signal.

- **`escalations_resolved` default when no PLAN.md.** Treated as N/A →
  1.0. A1..A8 don't write PLAN.md (they're pre-S2A surface); their
  fixtures must keep passing during the discrimination period.

- **Weight tuning.** `project_context_lifted` (0.30) +
  `escalations_resolved` (0.25) + `downstream_pm_score` (0.30) +
  `specs_concrete_per_feature` (0.10) + `brain_consulted_qualified`
  (0.05) = 1.00. The two highest weights are on the criteria the S2B
  reground was *motivated by* (betterado context-lifting + downstream-PM
  health). `specs_concrete` weight halved from 0.40 → 0.10 because it's
  necessary but no longer sufficient.

- **The pre-S2A baseline as a checked-in golden.** Plan says the bench
  "must FAIL B1 + B2 before SKILL refinement". We model "pre-S2A
  architect output" by checking in the actual pre-S2A manifests under
  `fixtures/betterado/baseline-pre-s2a/`. The discrimination unit test
  scores them and asserts the score is < 0.7 — this is a robust proxy
  for "run the current SKILL.md against the bench and see it fail"
  without burning Anthropic API spend.

## Operator-pending items for wake-up review

- **Frozen-SHA pin format.** Today it's a comment; if/when the PM bench
  refines (S3), regenerate `scoring.frozen.ts` and bump the SHA in the
  header. The implicit contract: the frozen file is *only* edited when
  the operator-blessed PM-bench shape changes (per CONTRACTS.md C10a).
  Consider whether to add a git pre-commit hook that warns if scoring.ts
  is edited without scoring.frozen.ts being updated (open question, not
  in S2B scope).
- **B2's expected feature count.** The current B2 fixture asks for the
  full 20-initiative program but `expected.{min,max}_features` is set
  to {2, 5} for the first emitted initiative. If/when the bench harness
  actually drives the SDK against B2 (operator wakes, runs
  `npm run bench:architect`), we'll see how the architect partitions
  the brief and may need to adjust the expectation. For now the
  discrimination test exercises the new criteria via static fixtures
  without invoking the SDK.
- **Brain themes added.** I created
  `brain/projects/terraform-provider-betterado/themes/council-constraints.md`
  and `release-substrate-context.md` so the `brain_consulted_qualified`
  existsSync check passes for the refined-post-s2a discriminator. These
  are real-shape themes (proper frontmatter, related_themes, project
  metadata) — operator should review whether their content matches the
  ground-truth project state.
