---
stage: S4
title: Dev-loop unifier + Review shrink (atomic landing)
branch: s4-unifier-review
date_started: 2026-05-23
operator: David Parsonson (asleep — autonomous agent execution)
contracts: [C1, C2, C3a, C3b, C10, C15a, C15b, C16, C16a, C16b, C19, C26, C27, C28]
---

# S4 — Decisions log

> This file records every load-bearing decision made during S4 implementation.
> When the operator wakes up, this is the audit trail.

## 1. Unifier iteration-cap default

**Decision:** **3 iterations.**

**Why:** Matches the plan's stated default (plan 04 §"Proposed refinement —
new unifier sub-phase", `Budget: 3 iterations`). Per **C19** there is **no $
cap** — iteration cap is the only bound. The 3 covers: iter 1 prep, iter 2
react to a quality-gate fail, iter 3 final polish. For send-back rounds
(`--feedback-ref` mode) the same 3 is reused per round (each `/forge-review`
nudge starts a fresh 3-iter session on top of the existing branch).

## 2. `forge demo run` invocation per shape

**Decision:** the unifier shells `demo.command` directly from
`.forge/project.json` — there is **no new `forge demo run` CLI subcommand**.
The plan referenced a notional `forge demo run` invocation as a verb; the
simplest thing that works is to execute the project-declared `demo.command`
argv via `execFileSync` from the worktree root.

For `shape: "browser"`:
- the project's `demo.preview_command` is started in the background
- forge picks a free port and exports it as `PORT`
- the project's `demo.command` (typically `npx playwright test ...`) is run
- artefacts land under the project-declared `demo.output` path (default
  `demo/<initiative-id>/`)
- the preview server is killed on exit

For `shape: "harness" | "cli-diff" | "artifact"`:
- the project's `demo.command` is run directly; stdout/exit captured.

For `shape: "none"`:
- the gate `demo_runs_clean` is **skipped**; the unifier still writes a
  `DEMO.md` rationale block, and `pr_self_contained` passes with no images.

The wiring for the browser-server lifecycle re-uses
`orchestrator/demo-runtime.ts` (already exists; in scope: read & possibly
extend; out of scope for S4: rewrite). For S4 we only need the **shape**
plug-point; the per-shape exec details bind at unifier-run time.

## 3. Where the unifier's closing commit lands

**Decision:** the unifier commits with the message:

```
feat(<initiative-id>): unify and demo
```

…on the **same branch** the per-WI Ralphs were committing to (`forge/<initiative-id>`),
on **top** of the last per-WI commit. Distinguished from per-WI commits by:

- Subject: `feat(<initiative-id>): unify and demo` (the **initiative**'s ID
  in the parens, never a `WI-<n>`); per-WI commits use
  `feat: ...` / `test: ...` etc with no scope qualifier.
- The commit is **idempotent**: if `git diff --cached` is empty after the
  agent's edits, no commit is made and the demo gate runs against the
  per-WI tip — that's a legitimate outcome for already-converged work.

## 4. C16a decision-table row-by-row test coverage

Every row of the C16a table maps to one test in `review-router.test.ts`:

| C16a row | Test name |
|---|---|
| `APPROVED` + no new commits | `decideAction: APPROVED with clean head → approve` |
| `APPROVED` + new commits since | `decideAction: APPROVED but commits after approval → ignore stale, re-evaluate` |
| `CHANGES_REQUESTED` | `decideAction: CHANGES_REQUESTED → send-back` |
| `COMMENTED` only | `decideAction: COMMENTED-only → send-back (intent inferred)` |
| Multiple reviewers, mixed | `decideAction: mixed reviewers with most-recent CHANGES_REQUESTED → send-back` |
| Latest commit author ≠ forge-bot | `decideAction: operator-direct-push → refuse-operator-push` |

Plus integration tests for the full router path (poll → write pr-feedback
→ enqueue), the cursor atomicity, and threading.

## 5. `parseAcceptanceCriteria` migration

The plan said the import in `pr-verdict.ts:22` is the only consumer outside
`reviewer-stage2.ts`. In **this worktree** (forked from `d108cb3`),
`pr-verdict.ts` **does not yet exist**. `parseAcceptanceCriteria` is also
private to `file-verdict.ts` (line 313). I am:

- **Exporting** `parseAcceptanceCriteria` from `file-verdict.ts`.
- The new `review-router.ts` imports it from there.
- The reviewer-stage2.ts deletion does not break it.

## 6. Verdict types relocation

`file-verdict.ts` currently imports `GetVerdict`, `Verdict`, `VerdictContext`
from `reviewer-stage2.ts`. After deleting `reviewer-stage2.ts`, those types
must live somewhere. I'm moving them into `file-verdict.ts` itself —
file-verdict is the file-based verdict transport; verdict-shape types
naturally live there. `cycle-context.ts` imports `GetVerdict` from
`reviewer-stage2.ts` today; that import updates to `file-verdict.ts`.

`benchmarks/e2e/simulator.ts` also imports `VerdictContext` etc. from
`reviewer-stage2.ts`; it updates to `file-verdict.ts`.

## 7. Reviewer shrink: where `runReviewer` goes

The plan says reviewer.ts shrinks to ≤ 80 lines as a thin scheduler-callback
that delegates to the router. **But** `cycle.ts:117` calls `runReviewer`
which has historically wrapped: demo prep → PR open → verdict gate.

Decision: post-S4 the cycle's review-phase is **near-empty** because the
unifier already opened/pushed and the PR exists. `runReviewer` becomes:

1. Resolve PR ref via `confirmPrMerged` (or new helper).
2. **Optionally** call the router once to drain any pre-existing PR
   comments into a `pr-feedback.md` (so the very first cycle still routes
   correctly if comments arrived before scheduler picked up).
3. Wait for verdict via the existing `getVerdict` (file-based) — exactly
   as before — but **without any Ralph loop**.
4. On approve → `pr-open` outcome; closure.ts decides `merged`.
5. On send-back → existing file-verdict already appends to fix_plan.md;
   for S4 we redirect to write the C3a `pr-feedback.md` and enqueue the
   unifier via the router. **But** the unifier is invoked by the
   scheduler/daemon, not from inside `runReviewer` — `runReviewer` just
   returns `send-back-cap-exhausted`-like and the cycle reports it.

To stay under 80 lines, `runReviewer` is a 3-step dispatcher; the heavy
lifting lives in `review-router.ts`. For C3b `--feedback-ref` mode, the
unifier already reads `pr-feedback.md` directly when invoked with that
flag.

## 8. e2e bench compatibility (simulator)

The plan says: "`benchmarks/e2e/` reused unchanged in shape; the simulator's
send-back round is now fulfilled by the unifier."

This requires the simulator to keep producing `Verdict` objects (no API
change). I'm preserving the `Verdict` / `VerdictContext` types verbatim
(moved to `file-verdict.ts`). The simulator's import path updates only;
its behaviour is unchanged.

## 9. `/forge-review` slash command updates

`.claude/commands/forge-review.md` lives **outside** the regular project
tree in the worktree-only `.claude/` symlink — and the prior agents have
reported that the slash command file is sandbox-restricted. **CONFIRMED
BLOCKED** during S4 implementation: both `Write` and `Edit` to
`.claude/commands/forge-review.md` were denied with permission errors.

**Operator-wake-up follow-up:** the operator needs to manually update the
slash command file with the new router-driven flow. The intended content
is preserved in the body of the prior `Write` attempt; reproduced here
for the operator to copy in:

````markdown
---
description: Review human moment — engage the open PR for an initiative (own session).
argument-hint: <initiative-id-or-handle> [--note "context"] [--abandon]
---

# /forge-review <initiative-id>

> Human interaction moment — run in YOUR OWN Claude session. Forge never
> auto-supplies a verdict or merges in production (Phase 6 / G9).

## How it works (post-S4 — router-driven)

Forge's review surface is the GitHub PR. The dev-loop unifier authored the
demo + PR description and opened the PR. The operator reviews on GitHub:
leaves comments, requests changes, approves, or merges directly.

Running `/forge-review <id>` invokes the **review-router**
(`orchestrator/review-router.ts`) — a non-LLM, deterministic poller that
fetches new PR events, applies the C16a decision table, and on send-back
writes `_queue/in-flight/<id>.pr-feedback.md` + drops a daemon marker.

Flags: `--note "<text>"` adds an operator-note section; `--abandon` moves
the manifest to failed.
````

The C16a decision table + the router's behaviour is fully documented in
`orchestrator/review-router.ts` (the canonical source) and in
`docs/phases/developer-loop.md` § Onboarding (operator-facing).

## 10. Bench: `cost_budget_respected` removal + redistribution

Per **C19**, the existing dev-loop bench's `cost_budget_respected` (0.15)
is removed and its weight is redistributed. I'm distributing across the
remaining 4 criteria roughly proportional to existing weights:

| Criterion | Old | New |
|---|---|---|
| `loop_completed` | 0.35 | 0.40 |
| `iteration_budget_respected` | 0.20 | 0.25 |
| `files_in_scope_respected` | 0.20 | 0.20 |
| `no_regression` | 0.10 | 0.15 |

Sum: 1.00. `cost_budget_respected` is **removed entirely**; the
`DevCriteria` type drops the field.

`DevExpected.max_cost_usd` is kept as a field name in case fixtures still
carry it (back-compat for cases.json), but the scorer ignores it.

## 11. Project-config: `metrics` + `sweep` optional blocks (C26 + C28)

Both blocks are **optional**. The loader returns them as `undefined` when
absent; the unifier branches on `manifest.type` (`implementation` |
`exploration`, per C27) to decide whether to invoke them.

For S4 the **implementation-shape** path is the one wired end-to-end;
exploration-shape (`type: exploration` + `metrics` + `sweep`) is loaded
into the schema but the unifier's runtime branch is a **stub** that emits
`unifier.exploration-mode-not-implemented` — that's correct scope for S4
per CONTRACTS.md (`project-sweep` is the new abstract skill, full
runtime wiring is a follow-up).

## 12. `embedDemoInPr` signature change

New signature:

```ts
export function embedDemoInPr(
  worktreePath: string,
  initiativeId: string,
  branch: string,
  trackedDemoDir: string,
  isPrivate: boolean,
): string | null;
```

- Pure composer; no `cpSync`, no `git add`, no `git commit`.
- Reads `<trackedDemoDir>/` for image enumeration and `DEMO.md` existence.
- Caller (`openPullRequest`) supplies `trackedDemoDir` (typically
  `<worktree>/demo/<initiative-id>/`) and the resolved `isPrivate` flag
  (the call site does the `gh repo view` query once).
- Returns the `## Demo` markdown body block to splice into the PR body,
  or `null` if no demo exists / not on GitHub.

New `assertTrackedDemoExists(worktree, initiativeId)` precondition in
`openPullRequest`: throws when `<worktree>/demo/<initiativeId>/DEMO.md` is
missing. The unifier MUST have written the tracked bundle before
`openPullRequest` is called.

## 13. Cursor atomicity

Per **C16b**: `cursor.json.tmp` then `rename(2)`. Parse failure on an
existing cursor file ⇒ treat as `cursor=0` (idempotent replay). The new
helper lives in `review-router.ts`.

## 14. `_queue/triggered/` marker for enqueueing the unifier

The router does **not** invoke the unifier directly. It drops a marker
file at `_queue/triggered/<initiative-id>.unifier-feedback.json` containing
`{ feedback_ref: "_queue/in-flight/<id>.pr-feedback.md", round: <n>,
created_at: <ISO> }`. The daemon polls this directory (already a
documented integration point) and invokes the unifier with
`--feedback-ref` set.

For S4 the daemon-side polling is **left as a follow-up** — the router's
unit tests verify the marker is written correctly; the cycle's
`runReviewer` reads the marker (or skips if absent) and invokes the
unifier inline. This keeps the S4 landing self-contained without a
parallel daemon rewrite.

## Decisions added during implementation

(Append below — keep chronological.)
