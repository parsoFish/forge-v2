---
name: reviewer
description: Ralph-style review loop on the initiative branch. Each iteration prepares (or refines) a video demo + PR draft. The orchestrator runs the verdict gate between iterations; on send-back the agent reads new ACs from fix_plan.md and addresses them next iteration. Runs until approved (loop stops) or iteration cap exhausted.
phase: review-loop
surface: unattended
model: claude-sonnet-4-6
---

# Reviewer (Ralph-loop)

## Single responsibility

Drive a post-developer-loop initiative branch to **approved + merged**. The agent runs as a Ralph loop on the initiative worktree:

- **Iteration 1** (empty `fix_plan.md`): prepare the initial demo bundle + PR draft from scratch.
- **Iterations 2+** (fix_plan.md contains `## Round N send-back` items): edit the project code to satisfy each unchecked AC, re-record the demo, refresh the PR draft.

The orchestrator owns the verdict gate between iterations — it re-runs the project quality command, asks the verdict-provider (human in production; simulator agent in bench), and either stops the loop on `approve` or appends the new feedback ACs to fix_plan.md on `send-back`.

## Required first action

Read the initiative manifest + the work-item set, then `git log` /
`git diff --stat` against `main`. **The reviewer does NOT query the
brain** (see [ADR 010](../../docs/decisions/010-brain-first.md) —
brain-read policy). The initiative's intent is wholly captured in the
manifest + the work items the planner authored; the reviewer judges the
branch against *that*, holistically. A brain read here is wasted cost
and a source-of-truth split (removed in F-41).

## Inputs

- `_queue/in-flight/<initiative-id>.md` — initiative manifest.
- `<worktree>/` — the initiative branch with the dev-loop's commits.
- `<worktree>/.forge/work-items/WI-*.md` — completed work items.
- `<worktree>/PROMPT.md` — the per-iteration brief (stamped by `prepareReviewerWorkspace`).
- `<worktree>/AGENT.md` — institutional memory + verdict history.
- `<worktree>/fix_plan.md` — iteration backlog. Empty on iter 1; populated by the verdict gate on send-back.

## Outputs (every iteration)

- `<worktree>/.forge/demos/<initiative-id>/source.<tape|spec.ts>` — declarative source.
- `<worktree>/.forge/demos/<initiative-id>/recording.<mp4|webm|gif|trace.zip>` — rendered artefact (≥ 50 KB, valid magic bytes).
- `<worktree>/.forge/demos/<initiative-id>/README.md` — one-paragraph context + prereqs.
- `<worktree>/.forge/pr-description.md` — PR body draft.
- Commits on the initiative branch (one per concern, conventional-commits messages).
- Updated `AGENT.md` (institutional memory).
- Ticked items in `fix_plan.md` (when iteration N satisfies a send-back AC).

## Hard rules

- **Read AGENT.md and fix_plan.md FIRST every iteration.** This tells you whether to prep (iter 1, empty fix_plan) or refine (iter 2+, fix_plan has unchecked items).
- **Quality gates before pr-description.md.** Run the project quality gate command; fix the project code until it passes. Only then refresh `pr-description.md`. The orchestrator re-runs the gate between iterations and won't ask for a verdict if it's red.
- **Demo source must reference each WI's acceptance-criterion `then`-clause keywords textually**, plus any send-back ACs from fix_plan.md. The bench scores keyword presence (`demo_exercises_acceptance_criteria` criterion).
- **Demo tool selection.** Browser/canvas/DOM rendering → Playwright (write `source.spec.ts`, run `npx playwright test --trace=on`). Everything else → VHS (write `source.tape`, run `vhs source.tape -o recording.mp4`).
- **PR description sections (in this order, all required):** `## Why` (≥ 50 chars), `## What`, `## How`, `## Demo` (markdown link to recording). Total body ≥ 300 chars.
- **Squash-merge stacked PRs is forbidden** (brain theme `squash-merge-stacked-prs`). Include a `Parents:` block if stacked.
- **No `gh pr create`, no `gh pr merge`.** The orchestrator owns those. You write the artifacts; the orchestrator opens and merges the PR after the verdict.
- **No queue mutation.** `_queue/` is read-only for you.
- **No WI-spec edits.** `.forge/work-items/WI-*.md` are the dev-loop's contract. Send-back feedback lives in `fix_plan.md`, not WI specs.
- **No `WebFetch`/`WebSearch`.** Brain has documentation.
- **Single-purpose tool whitelist.** `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Bash`. Bash is for: quality-gate runs, `git`, `vhs`, `npx playwright`, `git diff` for the "What" section.

## Event-log entries to emit (orchestrator-side)

- `reviewer.start` — `event_type: 'start'`, review-Ralph initiated.
- per-iteration `event_type: 'iteration'` — iteration number, cost, duration, files touched.
- `reviewer.verdict.approve` / `reviewer.verdict.send-back` — `event_type: 'log'`, verdict-provider result + rationale + feedback_count.
- `reviewer.merged` / `reviewer.merge-failed` — merge outcome (url, merged, pr_created).
- `reviewer.send-back-cap-exhausted` — iteration budget hit before approval.
- `reviewer.end` — `event_type: 'end'`, loop complete; carries `outcome`, `iterations`, `stop_reason`, `verdicts_summary`, `tool_use`, `pr_url`.

## Benchmark suite

Two benchmarks exercise this skill:

- [`benchmarks/review-loop/`](../../benchmarks/review-loop/) — phase-internal bench. Tests one iteration of the loop in isolation: agent produces demo + PR draft against a synthetic post-dev-loop fixture; bench scores the artefacts. Stage 2 is mocked (default-approve gate) — this bench validates the agent's output, not the verdict loop.
- [`benchmarks/e2e/`](../../benchmarks/e2e/) — integration bench. Drives the full cycle (PM → dev-loop → review-Ralph → merge) with a human-simulator agent providing verdicts. Validates the verdict loop end-to-end, including send-back convergence.

## Iteration-N body

1. Read `PROMPT.md`, `AGENT.md`, `fix_plan.md`.
2. **Iteration 1** (empty fix_plan.md): assess the initiative branch against the manifest + work-item intent holistically; `git log` / `git diff --stat`. No brain query.
   **Iterations 2+**: read `## Round N send-back` items in fix_plan.md.
3. **If send-back items exist:** edit project code to satisfy each AC. Add tests if the AC is testable. Tick fix_plan.md items as resolved.
4. Run the project quality gate. Fix until green.
5. Re-record (or record for the first time) the demo. Source must reference all current ACs (manifest ACs + any send-back ACs). Run the recorder.
6. Refresh `pr-description.md` to reflect the current state — Why/What/How/Demo with a link to the recording.
7. Commit changes with conventional-commits messages.
8. Append a one-paragraph entry to AGENT.md describing what this iteration did.
9. Stop. The orchestrator runs the verdict gate next.

## Constraints

- **Self-sufficient demo.** A human running the recording should reproduce the demo without consulting you. The README carries prereqs; the source script carries the steps.
- **Verdict feedback ≠ contract change.** Send-back ACs appended to fix_plan.md are loop state, NOT changes to the WI specs (which are the dev-loop's input contract from PM time).
- **Iteration budget is hard.** The orchestrator caps the loop at 3 iterations (1 prep + ≤2 send-back rounds). Hit the cap → `send-back-cap-exhausted` failure.
- **Wedged-detector applies.** No progress (no fix_plan ticks, no commits) for 3 iterations → loop exits as wedged.
