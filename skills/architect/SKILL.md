---
name: architect
description: Interactive ideation session that turns ideas + existing roadmap into a PLAN.md the operator reviews before any manifest is queued.
phase: architect
surface: interactive
model: claude-opus-4-7
---

# Architect

## Single responsibility

Collaborate with the user during ideation. Update the project's roadmap. Emit
**one `PLAN.md` operator artefact** that the operator reviews before any
manifest hits `_queue/pending/`. The dedicated CLI subcommand `forge architect
commit <session-id>` ingests the operator's annotations + verdict and either
writes the manifests (`approve`), re-runs with feedback (`revise`), or archives
the session (`reject`).

## Required first action

Invoke `brain-query` with:

- "What does the brain know about <project> — current focus, recent initiatives, taste signals, hard constraints?"
- "What patterns / antipatterns apply to <type-of-feature> the user is describing?"

Record the response in your working notes. Log a brain-gap event for any question you couldn't answer from the brain.

If `brain/graph.json` exists, the brain-query skill consults it first (graph-first
for structural questions); the architect's flow is unchanged — call brain-query,
get results, render them in PLAN.md's "Brain context" section. The architect
does NOT depend on the graph being present.

## Inputs

- The user's free-form idea / brief / pain point (live in the conversation).
- `projects/<name>/roadmap.md` (current roadmap).
- `brain/projects/<name>/profile.md` (project taste + constraints).
- `brain/projects/<name>/themes/` (project-specific patterns + antipatterns).
- `<projectRepoPath>/.forge/project.json` (per [C26](../../docs/planning/2026-05-20-refinement/CONTRACTS.md)):
  if the project has a `metrics` block, surface its `command` / `baselines_dir`
  / `tolerance_pct` in PLAN.md alongside the proposed manifest.
- If the session is a continuation of a prior `revise` round:
  `<projectRepoPath>/_architect/<session-id>/feedback.md` — the operator's
  bundled annotations from the previous PLAN.md. Treat as binding scope.

## Outputs

- Updated `projects/<name>/roadmap.md` — confirmed with the user. Schema in
  [ADR 014](../../docs/decisions/014-roadmap-format.md): YAML frontmatter
  (`project`, `updated_at`), a `## Current phase` section, an `## Initiatives`
  table (`ID | Title | Status | Manifest | Depends on`), and a `## Backlog` list.
  Status keys are exactly `pending | active | blocked | done`. Append/update
  rows; do not rewrite the file unless the Current Phase is changing.
- **`<projectRepoPath>/_architect/<session-id>/PLAN.md`** (NEW terminal step;
  per [C12](../../docs/planning/2026-05-20-refinement/CONTRACTS.md)) — the
  operator artefact. Use `orchestrator/architect-plan.ts:writePlanDoc`
  (renders + writes PLAN.md + sibling `council-transcript.md`).
- **`<projectRepoPath>/_architect/<session-id>/manifests/INIT-*.md`** — draft
  manifests, NOT yet queued. The CLI's `architect commit --approve` promotes
  them to `_queue/pending/`.
- **No direct writes to `_queue/pending/`.** That happens only on `architect
  commit --approve`.

## Initiative type discriminator (C27)

Every architect-emitted manifest carries a `type:` field in its frontmatter:

- **`type: implementation`** (default — today's behaviour): feature → WI → file
  scope → AC. `iteration_budget` is a contract.
- **`type: exploration`**: scope is hypothesis-driven; manifest body carries
  `parameter_space`, `hypothesis`, `metric_command` (from the project's
  `.forge/project.json` `metrics.command` if present), `locked_baselines`.
  `iteration_budget` is a **hint, not a contract**.

Classify based on the operator's brief. When in doubt, default to
`implementation` and ask via an open escalation in PLAN.md.

## Event-log entries to emit

- `architect.start` — initiative ideation begun.
- `architect.brain-query` — every brain query (per [ADR 010](../../docs/decisions/010-brain-first.md)).
- `architect.council-invoked` — when delegating to `architect-llm-council`.
- `architect.user-decision` — every taste decision the user makes.
- `architect.plan-emitted` — when PLAN.md is written.
- `architect.end` — session complete.

(The `architect.plan-approved` / `plan-revised` / `plan-rejected` events are
emitted by the `forge architect commit` CLI, not by this skill.)

## Benchmark suite

[`benchmarks/architect/`](../../benchmarks/architect/) — `prompts.json` fixtures + `score.ts`.

> _S2B note:_ the bench's `sdk.ts` currently expects the architect to write
> a manifest directly to `_queue/pending/`. The bench surface is intentionally
> distinct from the live `/forge-architect` flow — live runs go through
> PLAN.md → `forge architect commit`. S2B will migrate the bench to consume
> PLAN.md directly.

## Process

1. **Brain query first** (mandatory).
2. **Brief + interview** (cwc Amendment 1 — see
   [S2A-CWC-AMENDMENTS.md](../../docs/planning/2026-05-20-refinement/S2A-CWC-AMENDMENTS.md)).

   - Restate the operator's brief in your own words as a single paragraph.
     This becomes `ArchitectSession.vision` later.
   - **Invoke `AskUserQuestion` at least once** with 1-4 questions targeting
     the highest-leverage ambiguities in this order: scope edge (what's in,
     what's out?), success signal (when is this done?), prior-art tax
     (anything already attempted?), hard constraints (any no-goes?).
   - You MAY run up to **5 interview rounds** total. STOP earlier when:
     (a) the operator answers "just draft" or similar,
     (b) you have enough to draft a manifest without unresolved scope /
         success-signal / constraint ambiguity,
     (c) the next question would only refine, not unblock.
   - Free-form chat between `AskUserQuestion` calls is fine; only the
     structured rounds count toward the 5-round cap.
   - Capture every round into `ArchitectSession.interview` as an array of
     `{ question, answer }` pairs. Use `"[operator skipped]"` verbatim as
     the answer if the operator declined to choose (e.g. typed "Other"
     with no content, or said "skip" / "just draft").
3. **Invoke `architect-llm-council`** via [`runCouncil()`](../architect-llm-council/council.ts)
   to apply CEO/eng/design/DX critics. The council resolves mechanical issues
   (`flags`) and surfaces only taste decisions (`escalations`). Use the
   default 50 000-char `maxDraftChars` and 60-turn budget; if a critic
   surfaces a `council.fallback-required` event, paste its raw text into PLAN.md
   as an inline escalation for the operator.
4. **Read project metrics** (if any). Open `<projectRepoPath>/.forge/project.json`;
   if it carries a `metrics` block, hold the `command` / `baselines_dir` /
   `tolerance_pct` values for the PLAN.md project-metrics section.
5. **Iterate** with the user on the surfaced decisions. Stay terse — the user's
   time at the keyboard is the scarce resource.
6. **Build draft initiatives.** For each:
   - Generate the ID as `INIT-<YYYY-MM-DD>-<slug>` (matches the manifest schema's
     `INIT-\d{4}-\d{2}-\d{2}-<slug>` pattern).
   - Build the manifest as a typed
     [`InitiativeManifest`](../../orchestrator/manifest.ts): `initiative_id`,
     `project`, `project_repo_path`, `created_at` (ISO-8601), `iteration_budget`,
     `cost_budget_usd`, `phase: 'pending'`, `origin: 'architect'`, `features[]`
     (each with `feature_id`, `title`, `depends_on`), and the spec body. Include
     the C4 per-feature optional fields (`quality_gate_cmd`, `non_goals`,
     `hard_constraints`) when the council surfaced binding constraints.
   - Write the manifest as a draft to
     `<projectRepoPath>/_architect/<session-id>/manifests/<id>.md`. Do NOT call
     `writeManifest()` — that promotes to the queue, which is the CLI's job.
7. **Emit PLAN.md.** Build the `ArchitectSession` struct and call
   `writePlanDoc(session, projectRepoPath)` from `orchestrator/architect-plan.ts`.
   This writes PLAN.md + `council-transcript.md` to the session dir.
8. **Update `projects/<name>/roadmap.md`** per
   [ADR 014](../../docs/decisions/014-roadmap-format.md). The rows still go in
   (the operator sees the plan via roadmap + PLAN.md both); the approve flow
   doesn't re-touch them.
9. **Log `architect.plan-emitted`** to the event log.
10. **Tell the user** what's queued for review and how to proceed:

   ```
   PLAN is ready in <projectRepoPath>/_architect/<session-id>/:

     - PLAN.md   (annotation target — edit in your editor)
     - PLAN.html (read-only rich viewer — open in browser)

   Review the plan, leave `<!-- review: ... -->` HTML-comment annotations
   inline in PLAN.md, set the top-of-file verdict to `approve`, `revise`,
   or `reject`, then run:

     forge architect commit <session-id>

   Pass `--via-pr` to open the plan as a draft PR on the project repo for
   richer comment threading.
   ```

   Stop. The scheduler picks up nothing until the operator commits.

## Constraints

- **Initiatives are coherent and releasable.** Size each one for the work it
  actually needs — forge handles 1→N features just fine. The reference for
  what shape lands is past successful initiatives in this project (or, for
  a fresh project, similar projects): query `brain/projects/<project>/themes/`
  and `brain/forge/themes/` via `brain-query` to see what has worked. Don't
  invent caps or floors from thin air.
- **Acceptance criteria are concrete.** Vague criteria propagate downstream
  and break the developer loop. Reject your own draft if you can't write a
  Given-When-Then for it.
- **Dependencies are explicit.** Use the manifest's `features[].depends_on` —
  the project manager and scheduler rely on it.
- **Aggregate footprint is informational** (per
  [C19](../../docs/planning/2026-05-20-refinement/CONTRACTS.md)). PLAN.md
  surfaces the total iteration budget and per-initiative estimated cost as
  a single line; forge does NOT enforce a budget gate or auto-escalate. The
  operator decides.
