# S6A — Reflect: brain-lint trigger + retention tagging

> Stage S6A of the 2026-05-20 refinement batch. Wires `forge brain lint
> --scope cycle-touched-themes --cycle <id>` into the reflector's exit path,
> surfaces lint outcome as a new sibling `lint_status` field on `CycleResult`
> (per CONTRACTS C8), and tags every cycle archive with a `retention` tier so
> plan 01's cleanup pass has a load-bearing signal. **DOES NOT** touch slash
> UX or recap surface — those belong to S6B (C18c).

## Lint integration — design choices

### Where the trigger fires

After the reflector agent has exited successfully (themes + retro + cycle
archive written) and **after** the F-13 brain-gate has been recorded.
Specifically: between the existing brain-gate check and the existing
`reflector.end` emit. The brain-lint trigger is informational, not gating —
a `lint_status: 'flagged'` does NOT block `reflection_status: 'closed'`
(per `feedback_reflection_close_criterion` and plan 06 §"Failure handling").

### Invocation transport

In-process call to `runBrainLint` from `orchestrator/brain-lint.ts`.
Justification: no `execSync` ceremony, no PATH-dependency surface, faster,
and the lint module is already first-class in the orchestrator. The plan
06 council suggested the `forge brain lint` CLI but the in-process function
gives the same answers (and avoids spawning a child process during what is
already an SDK-call-heavy phase).

### `lint_status` enum

```ts
lint_status?: 'clean' | 'flagged' | 'skipped'
```

- `clean`     → `runBrainLint(...)` returned `exitCode: 0` (no errors).
- `flagged`   → `runBrainLint(...)` returned `exitCode: 1` (≥ 1 error finding).
- `skipped`   → lint module unavailable, runtime crash inside lint, or the
                reflector itself bailed before completing (so there are no
                cycle-touched themes to lint).

The field is **optional** on `CycleResult` (defaults to `'skipped'`/omitted
when reflection didn't run). Per C8 it is a **sibling** of
`reflection_status`, NOT a new enum value on the existing ternary.

### Failure mode: brain-lint module reachable but throws on a malformed file

**Decision:** classify as `lint_status: 'flagged'` with a `reason:
'lint-internal-error'` event metadata. Rationale: from the operator's
perspective, an unparseable theme IS a brain-debt signal — the cycle's
reflector either wrote something the lint module couldn't read, or
upstream brain corruption made the cycle-touched-themes scope unstable.
Both deserve operator attention next cycle. We do NOT treat this as
`skipped` because the lint module ran (it didn't fail to even start) —
`skipped` is reserved for "lint truly didn't execute".

### Auto-fix posture

Hard NO. We pass `fix: false` always — per plan 06 §"Brain-lint integration"
and `feedback_destructive_instruction_preserve_intent`, the operator is
the only mutating authority on the brain.

### Lint report artifact

When `lint_status === 'flagged'`, write the pretty-printed findings to
`_logs/<cycle-id>/brain-lint.md`. Even `clean` runs get a one-liner stub
("(no findings)") so the artefact's presence is a useful "lint ran"
signal for operators reviewing the log dir. Both cases emit a matching
event (`reflector.lint-invoked` or `reflector.lint-flagged`).

## Retention tagging — heuristic

Implemented as `assignRetention(events, themesWritten): RetentionTag` in
a new module `orchestrator/cycle-retention.ts` (>30 LOC threshold is met
once tests are factored in).

```
load-bearing   if  themesWritten.any(category === 'antipattern')
                  OR events.any(message === 'reviewer.verdict.send-back')
                  OR events.any(stop_reason === 'wedged')
                  OR events.any(event_type === 'error')
                  OR events.any(message contains 'wedge-recovery')

interesting    else if  themesWritten.length >= 2
                       OR events.count(reviewer.verdict.send-back) >= 1
                       OR themesWritten.any(category in {decision, antipattern})

routine        else
```

Notes on tightening over plan 06:
- "wedge / recovery event" expanded to: any error event, wedged stop, OR
  any reviewer send-back verdict. Plan 06 listed wedge/recovery only;
  send-backs are operator pain (slipped past the dev-loop), so they
  promote to `load-bearing` for the same reason an antipattern theme does.
- "≥ 2 send-backs" promotes to `interesting` (not `load-bearing`). Per
  plan 06 §"Cycle archiving / retention tagging" bullet 2.
- New theme of `category: decision` is a strong signal of cycle insight
  even without antipattern — promoted to `interesting`.

### `cited_by`

Extracted by scanning all themes under `brain/projects/<project>/themes/`
+ `brain/forge/themes/` whose body or frontmatter source list contains
the cycle id (`_raw/cycles/<id>.md` reference OR a `_logs/<id>/...`
reference). At write-time the agent is the source-of-truth for which
themes cite the cycle (it just wrote them). Implementation: read the
themes the reflector just wrote (delta = files mtime later than the
reflector.start ts) and grep their content for the cycle id.

## Frontmatter delta on cycle archive

```yaml
---
source_type: cycle
source_url: _logs/<id>/events.jsonl
source_title: Cycle <id>
cycle_id: <id>
initiative_id: <iid>
project: <proj>
ingested_at: <iso>
ingested_by: reflector
retention: load-bearing | interesting | routine   # NEW
cited_by:                                          # NEW (list)
  - brain/projects/<proj>/themes/<file>.md
---
```

The reflector agent's prompt is updated to emit `retention: <auto>` and an
empty `cited_by: []`. The orchestrator (`runReflector`) then **post-
processes** the archive to (a) compute the correct retention via
`assignRetention`, (b) populate `cited_by` from the deltas, overwriting
the agent's placeholder. This decouples retention from agent judgment —
the orchestrator owns the heuristic.

## Plan 01's cleanup-candidates flow (Deliverable #7)

Implemented as a small extension in `orchestrator/brain-lint.ts`:
when scope is `cleanup-dry-run`, the cleanup-candidate filter reads
each cycle archive's `retention` frontmatter and tiers it:

- `routine` cycles older than N days (default 30) → Tier B finding
  (`category: 'flag'`, message tagged with `tier: 'B'`).
- `load-bearing` → Tier C (no auto-summarise) — surfaced as a `flag`
  noting "never auto" but not as a cleanup candidate.
- Missing `retention` → tagged as "pre-S6A archive, manual triage".

This is a small additive sub-check in `cleanup-dry-run` scope only.
**Done**, not deferred to TODO.

## Things deliberately NOT changed

- `reflection_status` enum (per C8). Still ternary
  (`closed | failed | skipped`).
- `runReflector` return value shape — extended from `ReflectionStatus`
  to `{ reflection_status, lint_status }`. Cycle.ts adapter unpacks.
- Slash command UX (`forge-reflect.md`) — S6B's job.
- `_logs/<id>/recap.md` surface — S6B's job.

## Open / operator-pending

- Whether `lint_status: 'flagged'` should surface in the recap header
  (S6B) and the eventual notification path (general plan).
- Whether to extend `cited_by` to cross-cycle (a cycle T's archive could
  be cited by a theme written T+N cycles later). Currently scoped to the
  current cycle only — cross-cycle citations are deferred to plan 01's
  brain-index regeneration.
