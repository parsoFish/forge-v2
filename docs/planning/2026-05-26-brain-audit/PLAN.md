# Plan — Tier 4: Brain audit + three-brain restructure

> **Status:** drafted 2026-05-26 by the agent that landed Tiers 1–3
> + verification v3. Handed off to a fresh session for execution.
> **Source manifests:** the operator brief in this section + the prior
> Tier 4 stub at [`../2026-05-25-thin-forge/PLAN.md`](../2026-05-25-thin-forge/PLAN.md)
> (the part captioned "Tier 4 — Brain themes audit (split into a
> separate plan)").
> **Pre-handoff verification baseline:** [`docs/verifications/2026-05-26-cascade-cycle-v3/`](../../verifications/2026-05-26-cascade-cycle-v3/)
> (Tiers 1+2+3 confirmed shipping clean against a real cycle).

## Context

The brain has grown organically over many cycles. Tier 0 deleted three
themes whose *interpretation* was wrong (single-WI bias), but a
holistic audit hasn't happened yet. Beyond the spot-deletes the
operator wants a **structural reshape**: three distinct brains, each
with its own purpose and audience, replacing the current single-
brain-spanning-everything layout.

### The three-brain model (operator's mental model, 2026-05-26)

> "Each context requires a brain and they each need them for different
> reasons."

| # | Brain | Contents | Audience | When read |
|---|---|---|---|---|
| 1 | **forge-dev brain** | Graphify graph of forge project code, prompts, skills, ADRs about forge architecture, planning docs, phase closure log | Developers (human + Claude Code) editing forge itself | Forge-internal development sessions |
| 2 | **cycle-knowledge brain** | Cycle archives, antipatterns surfaced through prior cycles, reflections, cross-cycle patterns, cycle-related operational notes, **per-cycle architectural / design decisions** | Planning + reflection phases (architect, PM, reflector) inside cycles | Inside a forge cycle |
| 3 | **project-specific brain** (one per project, **lives inside the project's own repo**) | Project goals, project structure, project source code, project-specific patterns + antipatterns, project profile | All phases when working **on that project** | Inside a forge cycle whose initiative targets that project |

Usage matrix:

- **Inside a forge cycle**: planners (architect, PM, reflector) query
  Brain 2 + Brain 3 of the cycle's project. **Dev-loop + reviewer
  may query Brain 3** (the cycle's project brain). Per operator
  2026-05-26: now that Brain 3 is scope-clean (project-only, no
  forge-themes pollution), the historic ADR-010 risk of "agent
  reading the brain and going off-spec from the WI" goes away — the
  project brain is a legitimate supplemental source for dev-loop
  agents (e.g. project testing conventions, file-layout norms) that
  the WI may not have captured exhaustively. The WI is still the
  single source of *intent*; Brain 3 is supplemental *context*.
  **Dev-loop + reviewer never query Brain 1 or Brain 2** — forge-
  internal knowledge and cross-cycle interpretation are not their
  concern.
- **During forge development**: Brain 1 + Brain 2.
- **Brain 1 is never read during a cycle** — it's a forge-engineer tool.
- **Brain 3 is never read during forge development** — that's a project-specific dev concern, not a forge concern.

### Structural consequence: Brain 3 lives **in the project's repo**

> Operator note 2026-05-26: "I almost thought we could instead of
> keeping this as a forge artifact it could instead be built within
> the actual scope of the project."

Brain 3 is per-project and travels with the project. The previous
home `brain/projects/<name>/` (inside the forge repo, gitignored
under `projects/*` per current `.gitignore`) moves to
**`projects/<name>/brain/`** — i.e. into the project's own repo. This
means:

- When the project is cloned standalone (e.g. `parsoFish/claude-harness`),
  the project brain comes with it.
- The reflector writes project-specific themes into the project's own
  repo, so post-merge those themes are committed into the project.
- The forge repo's `brain/` directory loses the `projects/`
  subdirectory entirely. Forge tracks Brain 1 + Brain 2 only.
- For closed-source projects (e.g. `trafficGame`), the brain stays
  inside the closed repo — no leak.
- The cycle's worktree IS the project repo at the cycle's tip, so
  cycle-time brain-queries can read `<worktree>/brain/` directly.
  Reflector writes go to the same path; the cycle's normal commit +
  merge carries them through to project main.

## Current state assessment

```
brain/
├── INDEX.md             — navigation, regenerable
├── LINT.md              — lint policy
├── _archive/            — archived material (presumed retired themes)
├── _raw/cycles/         — cycle archives (raw event-log summaries) — keep
├── forge/
│   ├── antipatterns.md  — forge-level antipattern index
│   ├── decisions.md     — links to ADRs
│   ├── operations.md    — operator workflows
│   ├── patterns.md      — forge-level patterns index
│   ├── reference.md     — links to external resources
│   └── themes/          — forge-level themes (the body of Brain 2)
├── graphify-out/        — ONE graph spanning the WHOLE forge tree
│                          (orchestrator/, cli/, skills/, loops/, docs/,
│                          brain/ itself per CLAUDE.md line 115)
├── log.md               — phase closure log (forge dev history)
└── projects/<name>/
    ├── profile.md       — project profile (goals, constraints)
    └── themes/          — per-project themes (Brain 3 content)
```

The issues:

1. **No scope separation.** brain/forge/themes/ and brain/_raw/cycles/ are mixed under the same root as brain/projects/, and the graphify graph spans all of it. A query for "what's the dev-loop SKILL's contract?" can return cycle themes; a query for "what's a good WI shape?" can return forge-internal code symbols.
2. **graphify-out scope.** Currently indexes everything including `brain/` itself, so cycle-knowledge themes show up in code searches and vice versa.
3. **Reflection writes muddle the boundary.** When the reflector emits themes for a cycle on `claude-harness`, it writes BOTH to `brain/projects/claude-harness/themes/` (project-specific) AND occasionally to `brain/forge/themes/` (forge-level). The boundary is enforced by convention, not structure.
4. **brain-query SKILL has no scope parameter.** Every query scans every theme. Pollution noise grows quadratically as themes accumulate.

## Target state

**Inside the forge repo** (`/home/parso/forge/`):

```
brain/
├── INDEX.md                       — top-level navigator (regenerable)
├── LINT.md                        — lint policy (cross-brain)
├── forge-dev/                     — BRAIN 1
│   ├── graphify-out/              — graph scoped to forge code + prompts + docs
│   ├── log.md                     — phase closure log (was brain/log.md)
│   ├── decisions.md               — index of forge-architecture ADRs (was brain/forge/decisions.md)
│   ├── reference.md               — external resources (was brain/forge/reference.md)
│   ├── as-built/                  — architecture snapshots
│   └── notes/                     — forge-internal engineering notes
└── cycles/                        — BRAIN 2
    ├── _raw/                      — raw cycle archives (was brain/_raw/cycles/)
    ├── themes/                    — cycle-derived patterns + antipatterns (was brain/forge/themes/, trimmed)
    ├── antipatterns.md            — index over themes/ (was brain/forge/antipatterns.md)
    ├── patterns.md                — same, pattern index
    ├── operations.md              — operator workflows (was brain/forge/operations.md)
    ├── decisions.md               — per-cycle architectural / design decisions log (NEW; per Q3)
    └── graphify-out/              — graph scoped to cycles/ content only
```

**Inside each managed project's repo** (BRAIN 3, one per project — lives in the project, not in forge):

```
<project-repo>/
└── brain/
    ├── profile.md                 — project profile (was brain/projects/<name>/profile.md)
    ├── themes/                    — project-specific themes (was brain/projects/<name>/themes/)
    └── graphify-out/              — graph scoped to the project's own brain/ + the project's source tree
```

Notes on the layout:

- `brain/forge/{patterns,antipatterns,operations,decisions,reference}.md` index files split per operator Q3:
  - **Cycle-derived** (patterns, antipatterns, operations) → `brain/cycles/`
  - **Forge-engineering aids** (decisions about forge architecture, reference links) → `brain/forge-dev/`
  - Plus a new `brain/cycles/decisions.md` for per-cycle architectural / design decisions surfaced during cycle work.
- Each brain gets its own `graphify-out/` so the structural graph is scope-clean. Three smaller graphs replace one giant one. Each one is also cheaper to rebuild incrementally.
- `brain/_archive/` is **deleted** (operator Q2).
- `brain/log.md` moves into `brain/forge-dev/` (operator Q1).
- `brain/projects/` is **removed from the forge repo entirely** — each project now owns its own `brain/` (operator Q4). For each managed project this means an outbound migration: copy `brain/projects/<name>/` to `<project-repo>/brain/`, then commit + push in the project repo before deleting from forge.

## Brain-query SKILL update

`skills/brain-query/SKILL.md` must accept a **scope** parameter:

```
brain-query --scope=cycles    "<question>"
brain-query --scope=project --project=trafficGame "<question>"
brain-query --scope=forge-dev "<question>"
brain-query --scope=all       "<question>"
```

Convenient aliases the agent uses inside a cycle:

- Planner skills (architect/PM) default to `scope=cycles,project=<cycle.project>` — a UNION of Brain 2 + the cycle's Brain 3.
- **Reflector** defaults to `scope=all` (Brain 1 + Brain 2 + the cycle's Brain 3). Operator Q6: the reflector is an operator-coupled session, so loose access across all three is fine — it's the agent that's writing back to whichever brain anyway.
- **Dev-loop + reviewer** default to `scope=project,project=<cycle.project>` — Brain 3 of the cycle's project ONLY. Operator note 2026-05-26: this is an amendment to the ADR-010 "dev-loop doesn't read brain" rule. Now that Brain 3 is scope-clean (project-only, no forge-themes pollution), the original rationale ("don't risk an agent reading a forge-level theme and going off-spec from the WI") goes away. The WI is still the single source of *intent*; Brain 3 is supplemental *context* (project conventions, file layout, testing norms).
- A forge-dev session (no active cycle) defaults to `scope=forge-dev,cycles` — Brain 1 + Brain 2.

When no scope is given AND no cycle context is available, default to **all three** and emit a single-line warning (operator Q5: start permissive — the operator's expectation is that even with all-three selected, the tighter per-brain scopes still produce better results because of the scope-clean separation). The brain-query result should include a `scope` field in its output so the agent can see what was actually searched.

`brain-graph` SKILL (`skills/brain-graph/SKILL.md`) similarly takes the
scope and consults the right `graphify-out/` directory.

**ADR amendment required:** ADR 010 (brain-first) currently says
"dev-loop and reviewer do NOT read the brain". Amend to reflect the
new "may read Brain 3 only" rule. The skill files in `skills/developer-ralph/`
and `skills/developer-unifier/` (and the dev-invocation prompt
language at `orchestrator/dev-invocation.ts`) currently say the
dev-loop doesn't query the brain — update consistently.

## Content audit (carries the prior Tier 4 stub)

After the structural reshape lands, sweep the THEMES content per the earlier Tier 4 stub:

1. **Misleading interpretations.** Tier 0 dropped 3 themes (single-WI-bias). Likely more. Each remaining theme is reviewed against the question: *"Was this an overgeneralisation of one observation, or a durable lesson with cross-cycle evidence?"* Delete or rewrite the overgeneralisations.
2. **Stale themes.** Themes documenting behaviour that has since changed (e.g. wedged-detection — gone in Tier 2; benchmarks — gone in Tier 0). Either delete (if the behaviour is fully gone) or rewrite with the new state.
3. **Reference integrity.** After moves + deletes, sweep for broken `[[name]]` links, `cited_by` frontmatter entries, sibling-theme back-refs, INDEX.md state.

Carry **don't churn cycle archives** rule from the prior stub: `brain/cycles/_raw/` are raw observations + the durable source. Themes are interpretations OF the raw observations; those are what's audited.

## Migration plan (ordered)

Each step lands in its own commit so the operator can stop after any step.

### Step 0 — Snapshot + clean retired material

- `git tag brain-pre-restructure` on the current commit (a recoverable anchor).
- **Delete `brain/_archive/`** (operator Q2). Archived themes are not load-bearing; the git tag preserves them if anyone needs them later.
- Decide whether to start fresh on a graphify graph or carry forward — recommend **start fresh** (graphify is cheap to rebuild and the scope changes are large enough that the old graph would be more noise than signal).

### Step 1 — Brain-query scope plumbing (no content moves yet)

- Add a `scope` parameter to `skills/brain-query/SKILL.md` + the underlying brain-query implementation (look for the CLI helper that drives it; it lives somewhere under `cli/` or in the skill's runtime — locate before changing).
- Add the same to `skills/brain-graph/SKILL.md`.
- Default behaviour for missing scope: WARN + search all (preserves current behaviour during migration).
- New tests covering scope routing.

### Step 2 — Directory restructure

Move files according to the target layout above. Use `git mv` so history is preserved. Don't change content; this is purely structural.

**Inside the forge repo:**

- `brain/_raw/cycles/` → `brain/cycles/_raw/`
- `brain/forge/themes/` → `brain/cycles/themes/`
- `brain/forge/{patterns,antipatterns,operations}.md` → `brain/cycles/`
- `brain/forge/{decisions,reference}.md` → `brain/forge-dev/`
- `brain/log.md` → `brain/forge-dev/log.md`
- Create empty `brain/forge-dev/{as-built,notes}/` skeleton
- Create empty `brain/cycles/decisions.md` (new — for per-cycle architectural decisions per operator Q3)
- `brain/projects/` is **deleted from forge in this step** (after the next bullet moves its content)
- `brain/graphify-out/` will be replaced by per-brain dirs in Step 3 — leave the old one in place for fallback in this step, but stop trusting it.

**Outbound migration to each project repo** (operator Q4: Brain 3 lives inside the project, not forge):

For each managed project at `projects/<name>/`:

1. Confirm the project is a git repo (`cd projects/<name> && git status`).
2. `mkdir <project-repo>/brain && cp -r ../../brain/projects/<name>/* <project-repo>/brain/` (initial copy — content unchanged).
3. In the project repo: `git add brain/ && git commit -m "feat(brain): import project brain from forge (Tier 4 restructure)"` (plus the project's own conventions if different).
4. If the project has a remote (e.g. claude-harness → parsoFish/claude-harness), `git push`. Closed projects: just commit locally.
5. Back in forge: `git rm -r brain/projects/<name>/`.

Repeat for every managed project. Once done, `brain/projects/` doesn't exist in forge.

### Step 3 — Per-brain graphify rebuilds

Run `safishamsi/graphify` against each brain's content separately:

- **`brain/forge-dev/graphify-out/`** — indexes `orchestrator/`, `cli/`, `skills/`, `loops/`, `docs/`, `ARCHITECTURE.md`, `PRINCIPLES.md`, `brain/forge-dev/`. **Excludes** `brain/cycles/` + everything under `projects/`.
- **`brain/cycles/graphify-out/`** — indexes `brain/cycles/`. **Excludes** code + projects.
- **`<project-repo>/brain/graphify-out/`** — one per project, indexes the project's `brain/` **AND the project's source tree** (operator Q4: "project source code should be included in project level brains"). The post-commit hook running INSIDE the project repo refreshes this graph. Forge doesn't own it — the project does.

The forge-side post-commit hook (currently runs `graphify update .` on `brain/graphify-out/`) needs updating to refresh ALL forge-side brains (Brain 1 + Brain 2). Recommended: wrapper script `scripts/brain-graphify-all.sh` invoked by one hook. Project-side graphify hooks are set up per-project (a one-time install when each project gets its brain in Step 2).

Delete the old `brain/graphify-out/` once the per-brain replacements are healthy.

### Step 4 — Update CLAUDE.md + ADRs

- CLAUDE.md "## graphify" section: update path from `brain/graphify-out/` to the three new locations (`brain/forge-dev/graphify-out/`, `brain/cycles/graphify-out/`, `<project-repo>/brain/graphify-out/`); explain the three-brain model.
- CLAUDE.md "## The brain is the first source of knowledge" section: amend to reflect the new "planners read Brain 2 + 3; dev-loop + reviewer read Brain 3 only" rule.
- **ADR 010 (brain-first) needs a real amendment** — the old "dev-loop and reviewer deliberately do NOT read the brain" rule is changed by Q-new (2026-05-26): they may now read Brain 3 of the cycle's project, because scope-cleanness removes the original pollution-risk rationale. Write the amendment as a date-stamped block in the ADR (don't rewrite history).
- A **new ADR for the three-brain model** is recommended — the structural shape (where each brain lives, who reads what, why Brain 3 lives in the project repo) is load-bearing enough that future agents need a single authoritative reference. Number it the next available ADR slot.
- The skill files in `skills/developer-ralph/` and `skills/developer-unifier/` (and the dev-invocation prompt language at `orchestrator/dev-invocation.ts`) currently say the dev-loop doesn't query the brain — update consistently with the new Brain-3-only rule.

### Step 5 — Content audit (the original Tier 4 stub)

Per "Content audit" above. This is the longest step, but it's safer to do AFTER the structural reshape because:

1. Moves done in Step 2 may surface themes that "felt important" but are now obviously project-specific (move them out of cycles into projects/).
2. The graphify rebuild in Step 3 surfaces orphan themes (no inbound references) — easy delete candidates.

Land trims in small batches (≤10 themes per commit) so a future operator can bisect.

### Step 6 — Reference integrity sweep

After Step 5:

- Grep all `[[name]]` links + `cited_by:` frontmatter for broken pointers.
- Regenerate `brain/INDEX.md` (`forge brain index --write`).
- Run `forge brain lint` — every check should pass.

### Step 7 — Reflector hand-off update

Reflector currently writes themes to `brain/forge/themes/` AND `brain/projects/<name>/themes/`. Update the reflector invocation (`orchestrator/reflector-invocation.ts`) + the reflector SKILL so it writes:

- Cycle-level patterns → `brain/cycles/themes/` (inside forge repo)
- Project-specific patterns → `<projectRepoPath>/brain/themes/` (inside the **project repo**, via the worktree, so they're carried by the cycle's normal merge into project main)

Per operator Q6, the reflector has **loose read access to all three brains** (it's an operator-coupled session). The write split above is the reflector's call — same agent-discretion as today, just with the new paths. The reflector queries Brain 1 + 2 + 3 when reasoning about what happened in the cycle, but writes are confined to the cycle (Brain 2) and project (Brain 3) brains.

Critical: reflector writes to the project's brain need to happen BEFORE the cycle's auto-commit + push step, so the theme files land in the same commit as the rest of the cycle's work. If reflector writes happen AFTER, they'd need a second commit + push.

## Validation procedure

The operator wants concrete proof that the brain restructure improves
something measurable, not just feels tidier. **Track B (brain-query
precision/recall mini-bench)** is the primary signal per operator Q7
— it's auditable side-by-side (before / after numbers per question)
and isolates the brain-query change from the multi-factor noise of a
real cycle. Track A becomes the regression check that confirms the
restructure doesn't *break* anything. Track C is a quick smoke.

### Track B — Brain-query precision/recall mini-bench  (PRIMARY)

The operator's preferred validation per Q7. Designed as a side-by-
side comparison that produces concrete numbers + answers the operator
can audit row by row.

**Setup:**

- Pick **10 questions** the planner would realistically ask. Mix of
  scopes:
  - **forge-dev** questions: "Where is the iter-0 must-fail check implemented?", "What are the four composed gates the unifier must pass?", "Which ADR governs the brain-first rule?"
  - **cycle-knowledge** questions: "What antipatterns do we know about PM hidden coupling?", "What's the difference between the wedged check and gate-too-loose?" (note: wedged is gone post-Tier-2; the question becomes a stale-theme detector), "What did we learn about per-WI status colours?"
  - **project-specific** (claude-harness): "What patterns has the unifier-wedge surfaced on claude-harness?", "What's the recommended quality_gate_cmd shape for claude-trail?"
  - **cross-scope** questions: "What does the brain say about decomposing a feature into multiple WIs?" (PM-side; could hit cycle + project)

- For each question, human-curate the set of "themes that should
  match" — call this the **expected set**. This is the labour-
  intensive part; budget ~15-30 min curating the 10 questions.

- Save the question set + expected matches to
  `docs/verifications/<date>-brain-bench/questions.json`.

**Run procedure:**

1. **Baseline** (before restructure): check out `brain-pre-restructure`
   tag, run `brain-query` on each question (no scope flag; old behaviour
   scanned everything). Record returned themes + answer text per
   question into `baseline.json`.
2. **Post-restructure** (after Step 6): on `main`, run `brain-query
   --scope=<correct-scope>` for each question. Record returned themes
   + answer text per question into `post.json`.
3. **Negative control**: also run `brain-query --scope=<wrong-scope>`
   for a representative subset (3-4 questions). The wrong-scope
   results should be visibly worse — e.g. asking a forge-dev question
   with `--scope=cycles` should return mostly irrelevant cycle themes.

**Scoring:**

For each question:

- **Precision**: |returned ∩ expected| / |returned|. Higher = less noise.
- **Recall**: |returned ∩ expected| / |expected|. Higher = nothing missed.
- **Answer quality**: 1-5 operator rating of the returned answer text (subjective; the operator audits 10 ratings + leaves a note).

**Pass criteria:**

- Median precision **rises** vs baseline (less noise).
- Median recall **stays ≥** baseline (no relevant themes lost).
- Negative-control queries are visibly worse (proves scope is actually filtering).
- Operator's subjective rating averages ≥ baseline.

If recall drops below baseline → scope routing is too tight; relax it (the planner's default of `scope=cycles,project` should usually include forge-dev too on cross-scope questions, or the all-three permissive default kicks in).

**Deliverable:**

`docs/verifications/<date>-brain-bench/` contains:
- `questions.json` — the 10 curated questions + expected matches
- `baseline.json` — pre-restructure results
- `post.json` — post-restructure results
- `negative-control.json` — wrong-scope subset
- `summary.md` — per-question table + medians + the operator's notes

### Track A — Regression check via re-run

Re-run `INIT-2026-05-26-claude-trail-verify-cascade-v3` (or a v4
sibling with the same shape) AFTER the restructure lands. This is a
**regression guard**, not the primary signal — Track B is the
primary signal per operator Q7. Compare against the [v3 baseline](../../verifications/2026-05-26-cascade-cycle-v3/):

| Metric | V3 baseline | V4 expectation | Why |
|---|---|---|---|
| Cycle outcome | merge + reflection | merge + reflection | Restructure must not break cycle correctness |
| Reflector theme placement | mixed forge/projects | clean `cycles/` (forge) vs `<project>/brain/themes/` (project repo) split | Step 7 working |
| PM brain-query count + cost | 5 queries / $0.05 | should not increase | Restructure should reduce noise, not add cost |

If v4 merges + theme placement is clean + cost doesn't regress, restructure is safe to keep. If anything regresses, the diff between v3 and v4 traces the cause.

### Track C — Forge-dev session smoke test

A quick informal check that the forge-dev brain is useful on its own
turf: ask the brain (via `brain-query --scope=forge-dev`) a question
about forge code — e.g. "where is the iter-0 must-fail check
implemented?" — and confirm the result is the code file, not a cycle
theme. This is the strongest qualitative signal that the scope split
is working as intended.

## Anti-goals (carry from prior plan)

- **Don't replace the synthetic guidance with new synthetic guidance.** The replacement for "Cap at ~5 features" is brain-query for past successful initiative shapes, NOT "Cap at ~10 features".
- **Don't delete the durable principles.** Examples that stay:
  - "Consult the brain before starting work" (planner phases only).
  - "Emit structured events to the JSONL event log on every skill invocation."
  - "Use git worktrees for parallel work units."
  - "Don't re-invent a job queue / worker pool / process isolator" (ADRs 011-013).
  - "Spawn agents as Claude Code skills via the SDK, not CLI subprocesses."
  - "Use markdown artifacts to flow data between phases."
  - The five PRINCIPLES.md items.
- **Don't churn brain themes that record raw cycle observations.** `brain/cycles/_raw/` is raw data — keep all. Themes are interpretations OF the raw observations; those are what's audited.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Theme moves break inbound `[[name]]` links across project + cycle themes | Medium | Step 6 (reference integrity sweep) catches all of these |
| graphify scope misconfiguration creates a brain that's silently missing files | Medium | Step 3 outputs file count + node count; eyeball + assert > 0 nodes per brain |
| Reflector hand-off update breaks the next live cycle's theme placement | Medium | Track A (run a cycle after Step 7) is the regression check |
| brain-query default-to-all-scopes warning is too noisy | Low | Make the warning a single-line + suppress with `--scope=all` explicit |
| Content audit deletes themes that turn out to be load-bearing | Medium | Land trims in small batches (≤10 themes per commit) so git revert is cheap |
| `brain-pre-restructure` git tag forgotten | Low | Step 0 makes this explicit before any moves |

## Resolved questions (2026-05-26 operator hand-off)

The original open questions are answered + inlined into the plan above. For audit:

1. **`brain/log.md` location** → `brain/forge-dev/log.md` (Q1 answer).
2. **`brain/_archive/`** → **delete** (Q2 answer; git tag preserves history if needed).
3. **`brain/forge/{decisions,reference}.md`** → split per scope (Q3 answer): forge architecture decisions / external references → `brain/forge-dev/`; per-cycle architectural decisions get a new `brain/cycles/decisions.md`.
4. **Project source code in project-level brains** → yes (Q4 answer). Stronger: project brains move OUT of forge and INTO the project's own repo at `<project-repo>/brain/`. Forge's `brain/projects/` is deleted entirely.
5. **brain-query default scope** → permissive (Q5 answer); default to all three + warn. The operator's expectation is that better-scoped queries will still win on average due to the per-brain noise reduction.
6. **Reflector access** → loose across all three brains for reads (Q6 answer); writes split as before (cycle-level → `brain/cycles/themes/`, project-level → `<project-repo>/brain/themes/`).
7. **Validation track selection** → **Track B (precision/recall mini-bench) is the primary signal** (Q7 answer); Track A becomes a regression check; Track C is a quick smoke.

## Open questions still requiring operator input (none, but flag if discovered)

The next agent should surface any new ambiguities before executing destructive steps (esp. Step 2's project-brain outbound migration, Step 7's reflector path changes). If a question arises mid-execution, stop + confirm rather than guess.

## New rule introduced 2026-05-26 (worth surfacing for explicit sign-off)

**Dev-loop + reviewer may now read Brain 3** (the cycle's project
brain). This is an amendment to ADR 010 ("dev-loop and reviewer
deliberately do NOT read the brain"). Operator rationale: now that
Brain 3 is scope-clean (project-only, no forge themes), the original
ADR-010 risk of agent-going-off-spec-from-WI goes away. The WI
remains the single source of *intent*; Brain 3 is supplemental
*context*. Write this as a date-stamped amendment block in ADR 010 +
update the dev-loop / unifier SKILL files + `dev-invocation.ts`
prompt language. Land this amendment as its own commit so the
operator can review it standalone.

## Out of scope

- Bench replacement (Tier 5; the rebuild-from-scratch self-bench operator idea lives in the [parent thinning plan](../2026-05-25-thin-forge/PLAN.md) under "Open question — bench replacement").
- Per-WI live agent-flow tier in the UI (separate UI thread).
- Adding NEW themes proactively. The audit removes/edits; new themes come from real cycles + the reflector.

## Estimated session shape

The next agent should expect roughly:

- Step 0 + Step 1 (scope plumbing): 1–2 hours, mostly skill + SKILL.md edits + tests
- Step 2 (directory moves): 30 min, mechanical
- Step 3 (graphify rebuilds): 1 hour, including testing the post-commit hook
- Step 4 (CLAUDE.md + ADR updates): 30 min
- Step 5 (content audit): 2–4 hours; the bulk of the work
- Step 6 (reference integrity): 1 hour
- Step 7 (reflector hand-off update): 30 min
- Track A re-run + Track C smoke: 1 hour real-cycle wait + capture + commit
- Total: about a full session

If time gets tight, the priority order is: 0, 1, 2, 3, 7, Track A (skipping 4 + 5 + 6 if needed). The structural reshape + reflector hand-off update is the load-bearing change; the content audit can land later.
