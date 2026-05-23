---
area: brain
date: 2026-05-20
date_contracts_locked: 2026-05-21
date_graphify_amended: 2026-05-23
status: contracts locked — see CONTRACTS.md
contract_deps: [C7, C18a, C20, C21, C22]
---

# Brain refinement plan

> **Contracts locked.** This plan honours [CONTRACTS.md](./CONTRACTS.md).
> Where this plan and `CONTRACTS.md` disagree, `CONTRACTS.md` wins.
> Specifically: C7 (lint scope `cycle-touched-themes` added),
> C18a (plan split into 01a hygiene + 01b bench-growth + 01c graphify),
> C20 (brain has **two indexes**: Karpathy markdown wiki + Graphify
> knowledge graph), C21 (`brain/graph.json` is the canonical structural
> index, render artefacts are `graph.html` + `GRAPH_REPORT.md`), C22
> (new `brain-graph` skill owns the graphify integration).

## Problem (grounded in current state)

The brain works (`benchmarks/brain` at 94.4% / 17 of 18 + Opus-judge agreement) but it is **rotting at the edges**, and the rot is now a documented PM-killer. Concrete evidence:

- **126 empty contamination dirs** `brain/projects/__chained_test_proj_*` (verified `find -empty | wc -l = 126`), all left by `benchmarks/_lib/recorder-shims.ts` / e2e fixture teardown. They pollute every `ls brain/projects/`, every glob, and any future "list known projects" feature.
- **Real, costly staleness already burned a cycle.** `brain/projects/trafficGame/themes/2026-05-17-stale-brain-contradicts-code-pm-failure.md` documents the PM phase exhausting its full budget thrashing because two 2026-05-10 themes still described a deleted `CampaignLevels.ts` array. The antipattern explicitly asks for a staleness check — none exists yet.
- **`LINT.md` rules already silently violated.** `brain/projects/trafficGame/themes/` has five files with `category: snapshot` and one with `category: process` (neither is in the allowed set `pattern|antipattern|decision|operation|reference`). `brain/projects/trafficGame/patterns.md` lists 2 entries but at least 5 themes have `category: pattern` — index out of sync.
- **`brain-lint` is a SKILL.md only, no executable.** The reflection-bench closure log (`brain/log.md` 2026-05-10 entry, "What's next") flags this: `no_brain_corruption` re-implements a subset inline.
- **`INDEX.md` is itself stale** — claims "48 forge-level theme pages" and "5 sub-wikis"; reality is 62 forge themes and 7 project sub-wikis (slugifier is on disk under `brain/projects/slugifier/profile.md` but absent from `INDEX.md`).
- **Question set is frozen at 18.** No mechanism for reflector-discovered questions to land in `benchmarks/brain/questions.json`. The brain-gap-feedback-loop (`brain/forge/themes/brain-gap-feedback-loop.md`) ingests gaps into the brain but never grows the bench.
- **The next real test is betterado.** `brain/projects/terraform-provider-betterado/` has 3 themes + 1 raw source + profile (onboarded 2026-05-18, zero cycles run). Bench has zero coverage of it.

## Current state

- `benchmarks/brain/{questions.json, negatives.json, score.ts, judge.ts}` — 18 primary + 10 negatives, recall-weighted, Opus-judge gated.
- `skills/brain-query/SKILL.md` + `skills/brain-lint/SKILL.md` + `skills/brain-ingest/SKILL.md` — three skills, only brain-query is exercised by a real benchmark.
- `brain/LINT.md` — 6 rule categories declared; no enforcer.
- `brain/log.md` — 32 dated entries (append-only); last brain-specific lint was 2026-05-04 ("Pass B structural").
- Theme inventory: 62 forge themes (1,824 lines), 56 project themes across 7 sub-wikis; 126 empty contamination dirs; 6 cycle archives in `_raw/cycles/`.

## Proposed refinement

1. **`brain-lint` becomes an executable.** Motivation: SKILL-only means no CI/no cycle-gate. Deliverable: `orchestrator/brain-lint.ts` (CLI: `forge brain lint [--scope ...] [--fix]`) that implements all `LINT.md` rules + emits the same `_logs/<cycle-id>/brain-lint.md` report shape the SKILL already promises. Files: `orchestrator/brain-lint.ts` (new), `orchestrator/brain-lint.test.ts` (new), `package.json` (script `forge:brain:lint`), `skills/brain-lint/SKILL.md` (rewrite as thin invoker of the executable, mirroring `commands/*` refactor in commit 86473cd). Acceptance: green run against current corpus produces a report with the known violations called out (see §Brain-lint design) and exit code != 0 until they are addressed.

2. **Staleness detector (the campaign-graph lesson made code).** Motivation: contradictions are worse than gaps. Deliverable: a new check inside `brain-lint` that for every theme page parses `## Sources` and `[[wikilinks]]`, resolves each, and flags themes whose cited files no longer exist OR whose cited paths point to deleted lines (use `git log -- <path>` cheap check). Files touched: `orchestrator/brain-lint.ts` (`checkStaleness` module). Acceptance: lint output flags the two trafficGame themes that lost `CampaignLevels.ts` *before* a corrective pass, and clears after.

3. **Test-contamination scrubber + boundary.** Motivation: 126 empty dirs and growing. Deliverable: (a) one-shot deletion pass for the empty `__chained_test_proj_*` dirs (preserve none — they are demonstrably empty, no payload to protect; see §Cleanup playbook for the safety wrapper); (b) fix the e2e harness so the bench layered-tempdir never writes to live `brain/projects/` (`benchmarks/_lib/recorder-shims.ts` and `benchmarks/e2e/sdk.ts` audit). Files touched: `scripts/brain-scrub-test-contamination.ts` (new, idempotent), `benchmarks/_lib/*` (audit). Acceptance: zero `__chained_test_proj_*` dirs post-scrub; full bench run does not regenerate them.

4. **`INDEX.md` is generated, not hand-maintained.** Motivation: hand-maintained counts and project lists drift (proven: 48→62, missing slugifier). Deliverable: `forge brain index --write` regenerates `brain/INDEX.md` from filesystem (counts, sub-wiki listing pulled from each `profile.md` one-paragraph hook). Lint flags `INDEX.md` as orphan if regenerated content differs. Files: `orchestrator/brain-index.ts` (new), `brain/INDEX.md` (regenerated). Acceptance: regeneration is idempotent; running it now adds slugifier + corrects counts.

5. **Frontmatter normaliser + category whitelist enforcement.** Motivation: `category: snapshot|process` are silent rule breaks. Deliverable: in `brain-lint`, hard-fail on unknown category. Provide a `--fix` mode that maps known offenders interactively (snapshot → reference for architecture-snapshots; process → operation) but **never auto-applies without operator confirmation** per [`feedback_destructive_instruction_preserve_intent`](MEMORY). Files: `orchestrator/brain-lint.ts`. Acceptance: category whitelist enforced; hard-fail on writes; existing 6 violations either remapped (per resolved Open Q1) or whitelisted; lint exits clean.

## Slice boundary (per C18a)

Refinements **#1–#5 above ship as Stage S1.2** (independent of plan 06).
Refinements **#6–#7 below ship as Stage S5** (depend on plan 06's
reflector emit landing first). The two slices are independent
initiatives; do not bundle.

6. **Bench-growth pipeline (the question set must grow).** Motivation: the bench is frozen. Deliverable: reflector emits `_logs/<cycle-id>/brain-bench-candidates.jsonl` (each candidate = `{question, expected_sources, why_now, gap_id?}`); `forge brain bench:promote` reviews candidates, requires operator approval, appends to `benchmarks/brain/questions.json`. Gated: not every cycle adds; only cycles where a brain gap was filled AND the gap came up in ≥ 1 phase's `brain-query.gap` event. Files: `skills/reflector/SKILL.md` (new emit), `orchestrator/brain-bench-promote.ts` (new), `benchmarks/brain/questions.json` (target). Acceptance: a stale-brain-style cycle produces a candidate; operator promotes 1; bench grows from 18 → 19 without dropping below 94.4%.

7. **Betterado bench coverage.** Motivation: the next real cycle is betterado; bench currently knows nothing about Go/Terraform/ADO. Deliverable: 2 questions covering betterado's hard constraints (single-branch model, test harness state, `betterado_` prefix surface) added to `questions.json` (manually for this seed, not via mechanism 6 — bootstrap). Acceptance: bench at 20 cases, ≥ 94.4% pass rate, betterado questions all score ≥ 0.65.

## Slice boundary — 01c (graphify additive layer, per C20-C22)

Refinements **#8–#10 below ship as Stage S1.4** (parallel to S1.2;
independent of plan 06). They add a structural-graph index alongside
the existing markdown wiki — **additive, not replacement**. The 65
forge themes + 56 project themes are NOT rewritten.

The current brain implements Karpathy's three-layer pattern correctly
([`brain/forge/themes/karpathy-three-layer-wiki.md`](../../../brain/forge/themes/karpathy-three-layer-wiki.md)
references the canonical [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)).
Graphify ([`safishamsi/graphify`](https://github.com/safishamsi/graphify)
— Python CLI installable via `uv tool install graphifyy`,
51K stars, MIT, YC S26) covers a different axis: **structural relationships
across code+docs** (god nodes, communities, shortest paths, surprising
cross-file connections) that the brain's current `related_themes`
frontmatter captures only manually and at low rigour. Tree-sitter
local extraction needs no API key; LLM backends are optional for
richer semantic edges.

The community has already paired these two
([`sly-codechum/chum-mem`](https://github.com/sly-codechum/chum-mem),
[`lucasrosati/claude-code-memory-setup`](https://github.com/lucasrosati/claude-code-memory-setup)
— the latter claims 71.5× fewer tokens per session). Forge adopts the
established fusion rather than inventing one.

8. **Re-ingest the canonical Karpathy gist.** Motivation: `brain/_raw/web/karpathy-llm-wiki.chat.md` is a Pass-A synthesis because the gist was 404 at ingest time; the gist is now reachable. Deliverable: re-ingest via `brain-ingest`, replace the synthesis with the canonical source, update any theme that references the old synthesis. Files: `brain/_raw/web/karpathy-llm-wiki.md` (replace). Acceptance: themes that cite the gist now cite the canonical URL; the synthesis file is archived under `brain/_archive/`.

9. **Install real graphify + add hand-authored `brain-graph` skill (per C22).** Motivation: structural relationships across the brain are currently invisible to `brain-query`. Deliverable: `uv tool install graphifyy` (or `pipx install graphifyy`); new hand-authored `skills/brain-graph/SKILL.md` (an operator runbook over the real `graphify` CLI — does NOT accept graphify's auto-installable Claude Code skill via `graphify install`); `brain/graphify-out/graph.json` committed (per C21 — canonical structural index); sibling `graph.html` / `GRAPH_REPORT.md` / `cache/` / `manifest.json` gitignored; a `brain-lint` rule that flags stale graph (older commit than HEAD). Files: `skills/brain-graph/SKILL.md` (new), `brain/graphify-out/graph.json` (committed), `orchestrator/brain-lint.ts` (extend with graph-freshness check). Acceptance: `cd brain && graphify update .` produces `graphify-out/graph.json` + `graph.html` + `GRAPH_REPORT.md`; brain-lint detects when a theme changes without a graph refresh; brain-graph SKILL.md documents the five operations `update | query | path | explain | report`.

10. **Rewrite `brain-query` to consult the graph first (per C20 dual-index).** Motivation: structural questions should hit the graph before the keyword scan. Deliverable: `skills/brain-query/SKILL.md` updated so brain-query uses real `graphify query` / `graphify path` / `graphify explain` as the first lookup; falls back to keyword scan over themes if graph returns empty. The graph holds structural relationships; the themes hold narrative. Both are consulted; the order is graph-first. Files: `skills/brain-query/SKILL.md` (rewrite), `benchmarks/brain/questions.json` (add ≥3 structural questions). Acceptance: existing 18 keyword questions still pass; 3 new structural questions (e.g. "which theme bridges PR-as-review-window and reviewer-stage2 logic?") pass; bench question count grows ~30%; per-query token count drops measurably for graph-answerable questions.

## Brain-lint design

Concrete check categories (each = one function in `orchestrator/brain-lint.ts`, each = one unit test):

- **`checkFrontmatter`** — required fields present; `category` in the whitelist (catches `snapshot|process`); `created_at <= updated_at`. *Catches:* 6 current `category` violations in trafficGame.
- **`checkIndexSync`** — every theme with `category: X` appears once in `<X>s.md` (forge or project scope); no extra. *Catches:* trafficGame `patterns.md` listing only 2 of ≥ 5 pattern themes.
- **`checkSourceLinks`** — every link in `## Sources` and every wikilink resolves to an existing file. *Catches:* the campaign-graph staleness pattern.
- **`checkStaleness`** — for cited paths in tracked project directories, run `git log -1 -- <path>`; if file is deleted in the project HEAD, flag (don't auto-delete). Augment with optional `taste_decay` from `profile.md`: themes older than `90d * (1 / taste_decay)` get a warn. *Catches:* `2026-05-10-mvp-architecture-snapshot.md` once `src/` shape moves. **Note:** the brain cites *project* paths (gitignored at forge level); the staleness check resolves the project root via `brain/projects/<n>/profile.md` → cited project repo, then runs `git log` against *that* tree, not the forge root.
- **`checkOrphans`** — every theme reachable from `INDEX.md → category-index → theme`; every project dir reachable from `INDEX.md`. *Catches:* slugifier sub-wiki, hypothetical new betterado themes if forgotten.
- **`checkLengthSoftCap`** — warn > 60 lines, error > 100 lines (per `LINT.md`). *Catches:* future bloat; current corpus max is 84 (`pr-as-sole-review-window.md`), warn-level.
- **`checkContamination`** — anything matching `__chained_test_proj_*` or `__bench_*` is an error and lint refuses to proceed without `--allow-contamination`. Forces fix at the source.
- **`checkContradictions` (warn-only stretch goal)** — pairwise scan of theme titles for "X / not-X" pairs (e.g. titles containing the same key noun phrase but one ending `-pattern.md` and another `-antipattern.md` with overlapping `keywords`). Surfaces for human review; never auto-resolves. *Downgraded from a load-bearing check per council 01 flag — the staleness check (#2) is the load-bearing contradiction defence; this is supplementary.*

Every check returns `{category: 'auto-fix' | 'flag' | 'error', file, message}` so the existing `_logs/<cycle-id>/brain-lint.md` report shape (in `brain/LINT.md` §Failure handling) is preserved.

**Supported scopes (per C7):**

| Scope | What it walks |
|---|---|
| `--scope full` | every file under `brain/` (default) |
| `--scope forge-only` | `brain/forge/**` |
| `--scope project-only --project <name>` | `brain/projects/<name>/**` |
| `--scope single-file --file <path>` | one file |
| `--scope cycle-touched-themes --cycle <id>` | themes whose `## Sources` references the cycle at `brain/_raw/cycles/<id>.md` (consumed by reflect per plan 06) |
| `--scope cleanup-dry-run` | inventory-only, writes `_logs/<cycle-id>/cleanup-candidates.md` |

## Benchmark-growth mechanism

The bench grows only via a tightly-gated path:

1. **Source**: reflector emits `brain-bench-candidates.jsonl` (per refinement #6). One candidate = a question that this cycle would have benefited from being able to answer, derived from observed `brain-query.gap` events whose corresponding theme was just written.
2. **Triage**: `forge brain bench:promote --cycle <id>` lists candidates, links each to the just-written theme(s), and asks the operator to keep/drop/edit. Default: drop.
3. **Promotion**: kept candidates land in `benchmarks/brain/questions.json` with a new `id` and `source_cycle` field. Bench re-runs immediately; promotion blocks if accuracy falls below `94.4%` (the published bar in `CLAUDE.md`).
4. **Cap**: ≤ 1 promotion per cycle, ≤ 4 per month. Prevents poisoning the bench with high-volume cycles.
5. **Negative twin**: if the promoted question has a "should be a gap" sibling (e.g. "the brain knows X but should NOT claim Y"), reflector also drafts a `negatives.json` candidate.

## Cleanup playbook

For any deletion: the user's pinned `feedback_destructive_instruction_preserve_intent` is the rule — surface and confirm before irreversible removal of anything that *might* carry payload.

1. **Inventory first.** `forge brain lint --scope cleanup-dry-run` writes `_logs/<cycle-id>/cleanup-candidates.md` listing every candidate with: path, size, last-modified, is-empty, git-tracked.
2. **Tier candidates.**
   - **Tier A (auto-safe):** empty directories matching `__chained_test_proj_*` / `__bench_*` and not tracked by git. Delete in batch; log the count to `brain/log.md`.
   - **Tier B (operator-confirm):** non-empty contamination, files with `category: <unknown>`, oversized themes. Surface as a checklist; require explicit `--apply` flag.
   - **Tier C (never auto):** content flagged stale, contradictions, possible duplicates. Surface only; the reflector or operator authors the resolution.
3. **Archive, don't hard-delete, for tier B with payload.** Move to `brain/_archive/<YYYY-MM-DD>/<original-path>` preserving history. `git log --follow` still works.
4. **Bench gate.** Every cleanup pass ends with `npm run bench:brain` + `npm run bench:brain:negatives`. Accuracy must stay ≥ 94.4%. **An unexpected drop is itself a finding** (the bench was depending on rot — likely a bug) rather than a regression to revert.
5. **Log to `brain/log.md`.** Every pass appends one entry: `## [date] lint | cleanup pass — N tier-A deletes, M tier-B archives, bench: X/18 → Y/18`.

## Open questions for the operator

1. **Are `snapshot` and `process` first-class categories** we should add to the whitelist, or do they get remapped to `reference`/`operation`? The current usages (architecture-snapshot, test-stack-and-gates) feel architecturally distinct from pure reference docs.
2. **Bench-growth cadence — ≤ 1 per cycle / ≤ 4 per month, right values?** Or should it be event-driven only (a real gap was hit), not time-windowed?
3. **Staleness signal — `git log` per cited path is fine for a 60-file brain but quadratic-ish at scale.** Do we want a cheaper signal (e.g. hash of cited file content stored in frontmatter at theme-write time)?
4. **Contamination scrubber: hard-delete vs `_archive/`-move for empty dirs?** They are demonstrably empty, but moving keeps the audit clean.
5. **Per-project `INDEX.md`** (a generated `brain/projects/<n>/INDEX.md`) or keep the project-level navigation as just `profile.md` + the category indexes?
6. **Does betterado get a 2-question seed now, or does it wait until its first reflector cycle produces real ones?** Cold-starting feels artificial; waiting means bench has no betterado coverage during the project's most-fragile period.
7. **Graphify scope — brain-only or brain+forge-code?** Running `graphify .` at the forge repo root would graph forge's own code alongside the brain — high signal but couples brain freshness to code changes. Lean: **brain-only** initially (cleaner), revisit after a real query session. Affects S1.4 scope.
8. **MCP vs CLI for graphify?** MCP is faster and structured; CLI is simpler. Lean: **MCP first** since the brain-query rewrite (#10) needs structured returns anyway. Affects skill design in S1.4.
9. **Accept graphify's own `.claude/skills/graphify/SKILL.md` or hand-author `brain-graph/SKILL.md`?** Forge discipline is hand-authored skills. Lean: **hand-author** `brain-graph/SKILL.md` that delegates to graphify, matching the pattern of every other forge skill.

## Dependencies on other refinement plans

- **Plan 06 (reflect):** must own the `brain-bench-candidates.jsonl` emission and the post-cycle `brain-lint` invocation. The lint output becomes a reflector input ("what did this cycle leave in a bad state in the brain?").
- **Plan 02 (architect):** the architect already calls `brain-query` first; once lint surfaces contradictions, the architect should refuse to plan against a contradicting brain (flag → operator → corrective theme write before planning).
- **Plan 04 (review):** unchanged — review does not read the brain. But the reviewer's `_logs/<cycle-id>/` artifact set should include a final `brain-lint --scope cycle-touched-themes` so the cycle closes with a known-clean brain delta.
- **Plan 05 (PM):** PM's `brain-query` should surface lint's `stale` flag on a cited theme. Stale-cited content should bump the PM's "ask first" threshold for that work item.

## Acceptance criteria for THIS refinement

1. `brain-lint` is a runnable executable; `forge brain lint` exits non-zero against the corpus as it stands today (catches the 6 category violations + the trafficGame index mismatch + the 126 contamination dirs).
2. After one operator pass per the cleanup playbook, `brain-lint` exits clean.
3. `brain/INDEX.md` is regenerated and lists 7 sub-wikis with current counts.
4. Zero `__chained_test_proj_*` dirs remain; a full e2e bench run does not re-create them.
5. `benchmarks/brain` accuracy is ≥ 94.4% (current bar) post-cleanup and post-betterado-seed (target: 19+/20 primary).
6. `skills/reflector/SKILL.md` documents the `brain-bench-candidates.jsonl` emit; a real reflector run produces ≥ 1 candidate for the next operator-promoted cycle.
7. `brain/log.md` has new entries documenting the lint executable, the scrub pass, and the bench-growth promotion mechanism — making this refinement itself reflectable.
8. `CLAUDE.md` "Build & test" block lists `forge brain lint`, `forge brain index --write`, `forge brain bench:promote --cycle <id>` with one-line descriptions (per council 01 dx flag).
9. **(S1.4 — graphify additive layer):** `brain/graph.json` is committed; `skills/brain-graph/SKILL.md` is hand-authored; `brain-query` consults graph first then themes; brain bench grows ~30% with structural questions; bench still passes ≥ 94.4%; per-query token count drops measurably for graph-answerable questions.
10. **(S1.4 — Karpathy gist re-ingest):** the canonical gist is at `brain/_raw/web/karpathy-llm-wiki.md`; themes citing the old synthesis updated; synthesis archived.
