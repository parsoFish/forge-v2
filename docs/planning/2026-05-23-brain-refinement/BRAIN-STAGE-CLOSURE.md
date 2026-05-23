---
doc: brain-stage-closure
batch: 2026-05-23-brain-refinement
date_closed: 2026-05-23
status: closed (4 of 6 stages landed; Stages 5 + 6 deferred — both blocked on operator-supplied LLM API key)
stages_landed: 4 / 6
tests_final: 724 pass + 1 deliberate skip (carried over from 2026-05-20 batch)
---

# Brain stage review — closure (post-2026-05-20-batch follow-up)

After the 2026-05-20 refinement batch closed (see
[`BATCH-CLOSURE.md`](../2026-05-20-refinement/BATCH-CLOSURE.md)), the
operator requested a per-stage refinement+benchmark sweep. This is the
closure for the **brain stage** of that sweep (other stages — architect,
PM, dev-loop, review, reflect, general — are operator-pending follow-up
sessions).

## Stage landings

| Stage | Headline | Commit |
|---|---|---|
| **S1** | Stale-content sweep: dead reviewer-stage2 + cost_budget refs purged from CLAUDE/ARCHITECTURE/phase-docs/themes; INDEX.md refreshed; brain-graph SKILL trimmed (query/path/explain moved to brain-query); brain-lint check-count doc fixed (7 → 9) | `21dba4d` |
| **S2** | Graphify hooks + merge-driver: `graphify hook install` (post-commit + post-checkout, background); `.gitattributes` + local `.git/config` merge driver for `brain/graphify-out/graph.json` | `fe1c600` |
| **S3** | Corpus widening to forge root (C21a): symlink `./graphify-out → brain/graphify-out`; root `.graphifyignore` for excludes; corpus 122 → 404 files, graph 757 → 4085 nodes, 635 → 5488 edges; relations now include `imports_from`, `imports`, `calls`, `re_exports` (cross-file edges across all forge code) | `364ceb3` |
| **S4** | Connectivity lift: 99 themes converted to `## See also` + `[[wikilink]]` form; INDEX.md `## All themes (wikilink hub)` (101 entries); 10 project↔forge cross-cluster bridges (trafficGame → forge themes) | `05d2749` |
| **S5** *(deferred)* | LLM semantic pass `graphify update . --backend anthropic --all` — **BLOCKED** on operator-supplied API key (no `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / etc. in env) | — |
| **S6** *(partial)* | brain-query SKILL.md updated for C21a forge-root cwd + new `graphify affected` usage; bench questions Q24-Q26 added flagged `graph_dependent: true`; live `npm run bench:brain` **BLOCKED** on same API-key gap as wake-up item #2 from prior batch | this commit |

## What's on `main`

### New CLI / external surface

- `graphify hook install` (per-clone setup, documented in `skills/brain-graph/SKILL.md`).
- Graphify merge driver: per-clone `git config merge.graphify.*` setup, also documented.
- `./graphify-out` symlink committed at forge root.

### New modules

- `scripts/brain-wikilink-lift.ts` — idempotent script that normalises `## Related` → `## See also` and converts `[Theme: X](./y.md)` → `[[y]]` across all themes.
- `scripts/brain-index-hub.ts` — idempotent script that regenerates the `## All themes (wikilink hub)` section in `brain/INDEX.md`.

### Contract amendments

- **C21a** in `docs/planning/2026-05-20-refinement/CONTRACTS.md`: graphify corpus = forge-root tree walk; output canonical still `brain/graphify-out/graph.json` (per C21).

### Brain coherence

- ~10 HIGH dead-reference fixes in `CLAUDE.md`, `ARCHITECTURE.md`, `docs/phases/{review-loop,developer-loop,architect}.md`, and 4 forge themes — all pointing at the post-S4 unifier collapse + post-C19 budget removal.
- `brain/projects/trafficGame/themes/2026-05-17-reviewer-budget-undersized-medium-initiatives.md` re-tagged `retention: archived` + `supersedes_by: CONTRACTS.md C19`; preserved as historical evidence.
- INDEX.md now reflects the graphify-out layer + accurate project-theme count.
- 99 themes normalised; 101 wikilink entries in INDEX hub.

## Operator-pending items

These were sandbox-blocked or deliberately deferred; operator picks up on wake.

1. **`graphify update . --backend anthropic --all` (Stage 5)** — semantic LLM pass over the wider corpus. Estimated ~$5-15. Requires `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY` / `OPENAI_API_KEY`) in env. Without this, brain themes still have only intra-file `contains` edges (no cross-theme structural edges); code edges from `imports_from` / `calls` are unaffected and already in the graph.

2. **`npm run bench:brain` against the refreshed 26-question set** — same API-key blocker as prior batch wake-up #2 (the OAuth token doesn't authenticate the direct API). New Q24-Q26 are flagged `graph_dependent: true` and only make sense post-C21a; they exercise the code↔brain bridges that didn't previously exist.

3. **`brain/projects/terraform-provider-betterado/themes/{council-constraints,release-substrate-context}.md`** — these two themes (added in prior batch S2B) have a non-canonical frontmatter schema (`slug` / `project` / `date_added` instead of `title` / `description` / `category` / `created_at` / `updated_at`). brain-lint reports them as missing required fields. Carried over from prior batch wake-up #3 — operator confirms intent then either migrates schema or grants a frontmatter exception.

4. **brain-lint `category: snapshot | process` whitelist remappings (Tier-B)** — 6 trafficGame themes still fail `checkFrontmatter` with non-whitelisted categories. The `S1.2-TIER-B-PROPOSALS.md` script from prior batch wake-up #1 is still pending operator confirmation.

5. **Per-clone setup** for any other operator clone of forge:
   - `graphify hook install` from forge root.
   - `git config merge.graphify.name "graphify graph.json union-merger"`
   - `git config merge.graphify.driver "graphify merge-driver %O %A %B"`

## Closure timestamp

Final commit on `main` for the brain stage: this commit. Test suite **724/725** passing (1 deliberate skip, carried over from prior batch).

The brain stage of the per-stage refinement is closed pending the two API-key-blocked items.
