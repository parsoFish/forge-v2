---
stage: S2A
date: 2026-05-23
operator: David Parsonson (asleep)
branch: s2a-plan-doc
worktree: _worktrees/s2a-plan-doc
contract_deps: [C4, C12, C18b, C19, C26, C27]
---

# S2A — Architect plan-doc + Council robustness — DECISIONS

> Operator was asleep when this batch ran. The below records every choice
> that needed making so the next pass can audit (and revert) cheaply.

## 1. Event names

The architect plan-doc emits four events. All match `EventLogEntry` shape per
ADR 008 — `phase: 'architect'`, `skill: 'architect-plan'`, `event_type` chosen
from the closed enum (`start | end | log | error | tool_use | iteration`).
The plan-doc verbs ride on `event_type: 'log'` with a stable `message` prefix
and the verb encoded in `metadata.action`:

- `architect.plan-emitted` — `event_type: 'log'`, `message: 'plan-emitted'`, `metadata.action: 'plan-emitted'`.
  Emitted by the architect skill when it writes PLAN.md.
- `architect.plan-approved` — `event_type: 'log'`, `message: 'plan-approved'`, `metadata.action: 'plan-approved'`.
  Emitted by `forge architect commit` on `verdict: approve`.
- `architect.plan-revised` — `event_type: 'log'`, `message: 'plan-revised'`, `metadata.action: 'plan-revised'`.
  Emitted by `forge architect commit` on `verdict: revise`.
- `architect.plan-rejected` — `event_type: 'log'`, `message: 'plan-rejected'`, `metadata.action: 'plan-rejected'`.
  Emitted by `forge architect commit` on `verdict: reject`.

Other existing architect events (`architect.initiative-emitted`, etc.) stay
unchanged. The `plan-approved` event is paired with one `initiative-emitted`
event per manifest written, so the audit trail is still: `plan-emitted` →
operator-edit-time → `plan-approved` → N × `initiative-emitted`.

## 2. Annotation format

Three HTML comment markers — the same shape proven by `pr-as-sole-review-window`
for the reviewer phase:

- **Top-of-file verdict** — `<!-- verdict: approve | revise | reject -->`.
  Must appear on its own line, anywhere in the document; the first match wins.
  Missing verdict ⇒ parser returns `verdict: null` (operator hasn't completed
  the review yet — CLI declines politely).
- **Inline review comment** — `<!-- review: free text up to next --> -->`.
  Each appears on its own line; the parser records the **line number** of the
  comment (1-based) and the inner text. Multi-line bodies are NOT supported in
  v1 (keep it greppable; one comment per line). The operator writes plain
  prose; the bundler downgrades these to a markdown list for the council.
- **No special mark for `reject`** — `<!-- verdict: reject -->` is enough.

## 3. `--via-pr` fallback strategy

`--via-pr` opens a draft PR on the project repo's `forge/architect/<session-id>`
branch carrying just `PLAN.md`. When the project has no remote configured
(early-stage projects) we degrade as follows:

1. Detect with `git -C <projectRepoPath> remote get-url origin` (non-zero exit
   ⇒ no remote).
2. Print a clear stderr warning:
   `forge architect commit: --via-pr requested but project <name> has no `origin` remote; falling back to local-edit mode. Edit projects/<n>/_architect/<sid>/PLAN.md directly.`
3. Continue in local-edit mode — the parsing path is the same regardless of
   surface, so no behavioural difference beyond the warning.

The architect skill prints both paths up front (local-edit and `--via-pr`) so
the operator can pick at commit time without re-running the architect.

## 4. `scripts/council-refinement-plans.ts` disposition

Action picked: **delete** from this worktree's `scripts/` if present (it's
not — the worktree's `scripts/` only carries the two existing scripts).
The main repo carries the file as a one-off; this stage doesn't touch the
main repo. The note for the eventual main-branch cleanup is captured in
this DECISIONS doc:

> Once S2A lands on `main`, delete `scripts/council-refinement-plans.ts`.
> Its purpose (push refinement plans through the council programmatically)
> is now subsumed by the robustness fixes in `council.ts` — the inline
> Agent-tool fallback the batch used in 2026-05-20 is no longer needed.

If the worktree turns out to have the script, S2A will delete it. (Confirmed
absent at branch checkout time.)

## 5. PLAN.md retention

Open Q5 of plan 02 (auto-archive vs retain forever) — picked **retain**.
`projects/<n>/_architect/<sid>/` stays on disk until the operator decides to
prune. `_archived/` is the only path that gets state mutations on `reject`
(per C12). Rationale: the audit trail is small (~6 files per session) and
operator surprise at "I had a plan there yesterday and now it's gone" is a
real cost. If accumulation becomes a problem (>~50 sessions), a follow-up
`forge architect prune` subcommand can sweep on age.

## 6. `revise` semantics

Open Q3 (replace vs amend) — picked **replace** (clean slate, council runs
free). Rationale: amend is cheaper but couples adjacent revise rounds in a
way that's hard to predict ("does this comment apply to the iteration the
operator was looking at, or the new one I just regenerated?"). Replace is
honest. The cost premium of a second council run is bounded by C24 (Haiku
for 3/4 critics) and prompt caching (C23) — neither delta is alarming.

## 7. Where the session dir lives — exact path

`<projectRepoPath>/_architect/<session-id>/PLAN.md` per C12. The architect
session is rooted in the **project repo**, not forge root (so the PR-on-project
mode in C12 works without copying state across repos). The session dir
contains:

- `PLAN.md` (the operator-edited artifact)
- `council-transcript.md` (raw council output, sibling to PLAN.md)
- `feedback.md` (only on `revise` — bundle of operator annotations)
- `manifests/INIT-*.md` (drafts that get promoted to `_queue/pending/` on approve)

`<projectRepoPath>` is read from the architect's environment; tests pass
an explicit `projectRoot` to `writePlanDoc` so they don't depend on a live
project tree.

## 8. Council robustness — chunking semantics

`runCouncil` gains a `maxDraftChars?: number` config (default 50_000).
- If `draft.length > maxDraftChars`, the runner slices to the first
  `maxDraftChars` characters and prepends a `[draft was truncated for the
  council critic from N chars to maxDraftChars chars]` line. The full draft
  is still preserved in the calling architect's working memory; only the
  critic-fed slice is shortened.
- The default 50_000 chars is generous (~15k tokens at 4 chars/token) — the
  2026-05-20 batch's failed plans were ~13k chars; the new ceiling is ~4×.
- Critics that need to see the trailing sections of a long draft can be
  rotated through with a follow-up slice; this is out of scope for S2A but
  documented as a future knob.

## 9. Council robustness — retry + fallback flow

`runCouncil` flow on `structured_output` failure:

1. **First attempt** uses the existing JSON-schema `outputFormat`.
2. **Retry once** with an augmented system prompt that says: "the previous
   attempt returned no structured_output. Repeat your verdict now as a
   ```json fenced block with the same shape." The runner parses the first
   ```json … ``` block out of the assistant text.
3. **Second failure** ⇒ emit `council.fallback-required` (telemetry; surfaces
   in cycle events) and **return a partial CouncilResult** with the critic's
   raw text in `perCritic[].verdict.escalations[0].question` for the architect
   to read. The runner does NOT throw — the architect can decide to surface
   the fallback to the operator inline.

The 60-turn `maxTurns` cap stays well above the SDK's natural exit for a
structured-output critic (≤ 3 turns observed); the bump exists for resilience,
not capacity.

## 10. Test isolation pattern

All `architect-plan.test.ts` tests use `mkdtempSync` (the same pattern as
`manifest.test.ts:107` and `benchmarks/architect/sdk.ts:104`). No test
touches the real `_queue/pending/`. The CLI dispatch tests also chdir into
a tempdir before invoking the dispatch function so they can't trample
production state.

## 11. C19 informational framing — exact wording

The aggregate-footprint section is titled `## Aggregate footprint (informational)`
and uses the language **"informational only — no gate, no auto-escalation"**
in its opening sentence. Tests pin this exact wording so any future drift
fails fast.

Specifically the rendered section contains a literal `informational` and
NONE of:
- `gate`
- `threshold`
- `auto-escalate` / `auto-escalation`
- `aggregate_budget_declared`

## 12. C27 type discriminator — manifest carries it

`exploration` manifests carry `type: 'exploration'` in the frontmatter,
plus four extra fields in the rendered PLAN.md drawer:
- `parameter_space` (markdown body — variable name + value range per row)
- `hypothesis` (one-line markdown)
- `metric_command` (string array — same shape as `quality_gate_cmd`)
- `locked_baselines` (string array — paths to baseline files; usually one)

`implementation` is the default and matches today's behaviour exactly.
The PLAN.md renderer reads `session.type` (default `'implementation'`) and
branches.

`iteration_budget` is rendered as "iteration budget: N (hint, not contract)"
for `type: exploration`; as "iteration budget: N" otherwise. The downstream
PM consumer reads the `type:` discriminator and branches per C27.

## 13. C26 metrics surface — exact rendering

When the project has a `.forge/project.json` with a `metrics` block, the
PLAN.md renderer surfaces a small section directly after the proposed
initiatives table:

```
## Project metrics (per .forge/project.json)

- command: bash -lc "<cmd>"
- baselines_dir: docs/baselines/
- tolerance_pct: 1.0
```

The architect doesn't choose the values; it just mirrors them so the
operator can confirm the proposal uses them correctly. If the block is
absent, the section is omitted entirely.

## 14. What was NOT implemented in S2A (intentional)

Per the constraints in the brief:
- B1 / B2 betterado fixtures and the `benchmarks/_lib/handoff.ts` module
  belong to S2B.
- `benchmarks/architect/scoring.ts` is NOT touched — the new criteria
  (`project_context_lifted`, `escalations_resolved`, etc.) are S2B's job.
- We DO update `skills/architect/SKILL.md` and the slash command, but we
  do NOT change `benchmarks/architect/sdk.ts`'s expectation that the
  architect writes a manifest into `_queue/pending/` (that's the bench
  surface; S2B will redirect it). Live runs go through `/forge-architect`
  → PLAN.md per the refined skill; bench runs still synthesise the
  manifest path directly. The two-path situation is documented in the
  skill, and the bench keeps working until S2B chooses to migrate it.

The above is deliberate: S2A is **one shippable slice** with no
half-landed surface. S2B can land independently and informed by what
operating S2A teaches us.

## 15. Operator-pending: `.claude/commands/forge-architect.md` update blocked

The harness sandbox refused all writes to
`.claude/commands/forge-architect.md` (Write / Edit / Bash all denied).
The required edit is small (description line + terminal-step prose
pointing at PLAN.md instead of `_queue/pending/`); the file already
delegates to `skills/architect/SKILL.md` for the actual behaviour, so
the contract change has already landed via SKILL.md (the single source
of truth per the slash-command's own text). The wake-up review should
manually apply the diff below to keep the slash command's surface text
consistent:

```diff
-description: Architect human moment — turn a vision into queued initiatives (own session, out-of-cycle).
+description: Architect human moment — draft a PLAN.md the operator reviews before any manifest is queued (own session, out-of-cycle).
...
-When the skill's contract is satisfied (roadmap rows updated +
-schema-valid `_queue/pending/INIT-*.md` written and validated), **stop** —
-do not start a cycle; the scheduler picks the queue up on its own.
+When the skill's contract is satisfied (roadmap rows updated +
+`<project-repo>/_architect/<session-id>/PLAN.md` written), **stop** —
+do not start a cycle, do not promote draft manifests to the queue.
+Print the path to PLAN.md and the next command:
+
+    forge architect commit <session-id>  [--via-pr]
```

This is the only file in S2A scope whose update was harness-blocked.
