---
name: reviewer
description: Verify the post-developer-loop initiative branch is functional, record a video demo, and draft a PR description. Stage 2 (interactive human review + send-back loop) is implemented separately.
phase: review-loop
surface: unattended
model: claude-sonnet-4-6
---

# Reviewer — Stage 1 (Review-prep)

## Single responsibility

Take a post-developer-loop worktree (every work item at `status: complete`), and emit two artefacts to the worktree:

1. **A video demo bundle** at `<worktree>/.forge/demos/<initiative-id>/` (source script + recording + README).
2. **A PR description draft** at `<worktree>/.forge/pr-description.md`.

The orchestrator handles all side-effecting work after this skill exits — `gh pr create`, queue movement to `_queue/ready-for-review/`, and the desktop notification per [ADR 013](../../docs/decisions/013-notifications.md). Do **not** call `gh pr create`, do **not** move queue files, do **not** fire notifications.

> **Stage 2 (human review + send-back loop) is NOT implemented in this skill.** That is a separate plan that runs after stage 1 closes. The contract here is review-prep only: produce a demo and a PR draft, gated by quality-gate health.

## Required first action

Invoke `brain-query` with:

- "What patterns / antipatterns apply to PR descriptions and demo recordings?"
- "Have past reviews of similar initiatives surfaced common gotchas?"
- "What's the project's preferred merge style (merge / squash / rebase)?"

Always-relevant brain themes:

- [`brain/forge/themes/squash-merge-stacked-prs.md`](../../brain/forge/themes/squash-merge-stacked-prs.md) — v1 lesson, squash-merging stacked PRs produces lost-source-files cascades.
- [`brain/forge/themes/layered-merge-order.md`](../../brain/forge/themes/layered-merge-order.md) — merge layer 0 first with health-check, then layer 1; reviewer enforces this.
- [`brain/forge/themes/markdown-artifact-flow.md`](../../brain/forge/themes/markdown-artifact-flow.md) — every cross-phase artefact is greppable markdown.

Then read `brain/projects/<project>/profile.md` and any project-specific reviewer themes.

## Inputs

- `_queue/in-flight/<initiative-id>.md` — initiative manifest (with feature list; all work items completed).
- `<worktree>/` — the project at the developer-loop's final commit.
- `<worktree>/.forge/work-items/WI-*.md` — completed work items, each with `acceptance_criteria` (Given-When-Then). The demo source must reference each WI's `then`-clause keywords (greppable evidence the demo exercises the criteria).
- `_logs/<cycle-id>/events.jsonl` — to extract notable decisions for the PR's "How" section.

## Outputs

### 1. PR description draft — `<worktree>/.forge/pr-description.md`

Plain markdown (no frontmatter). Required sections, in this order:

```markdown
## Why

<1-3 paragraphs explaining the initiative's goal and what problem it solves. Cite the manifest's
intent. Why ≥ 50 chars. This is the load-bearing section — the diff shows what; this explains why.>

## What

<bullet list, one bullet per feature in the manifest. Each bullet ≤ 140 chars.>

## How

<1-2 paragraphs covering key decisions made during the cycle. Reference event-log entries
(`brain-query` results, architecture choices, antipattern mitigations applied).>

## Demo

<markdown link to the recording in `.forge/demos/<initiative-id>/`. State the tool used (VHS or
Playwright) and any prereqs (e.g., "Run `npx playwright show-trace .forge/demos/.../recording.trace.zip`
to play").>
```

If the PR is part of a stacked sequence (parent PRs must merge first), include a `Parents:` block listing parent PR numbers or branch names. If `Parents:` is present, the orchestrator's `gh pr merge` call will use `--merge` not `--squash` (per [ADR 016](../../docs/decisions/016-demo-recording-tooling.md) and the squash-merge-stacked-prs antipattern).

Body length floor: 300 chars total. Three-line PR descriptions are rejected by the bench.

### 2. Demo bundle — `<worktree>/.forge/demos/<initiative-id>/`

Layout locked in [ADR 016](../../docs/decisions/016-demo-recording-tooling.md):

```
<worktree>/.forge/demos/<initiative-id>/
├── source.<tape|spec.ts>                # declarative source — greppable
├── recording.<mp4|webm|gif|trace.zip>   # the rendered artefact
└── README.md                            # one-paragraph context + prereqs
```

**Tool selection rule** (no exceptions other than browser/canvas):

- **Browser / canvas / DOM rendering** → Playwright. Write `source.spec.ts`. Run `npx playwright test source.spec.ts --reporter=list --trace=on` (or `video: 'on'` in config). Output is `recording.trace.zip` or `recording.webm`.
- **Everything else** (Python lib, bash CLI, TS lib, REST via curl, terminal apps) → VHS. Write `source.tape`. Run `vhs source.tape -o recording.mp4` (or `.gif`, `.webm`). The `.tape` declarative DSL has `Type`, `Enter`, `Sleep`, `Show` directives — see VHS docs.

**Greppable acceptance-criteria evidence.** The demo source must reference each work-item's acceptance-criterion `then`-clause keywords as commands, expected output, or assertion text. The bench scores this as `demo_exercises_acceptance_criteria` (heuristic keyword presence). A 5-second video of a black canvas will fail the rubric.

**`README.md` content** (one paragraph):
- One sentence on what the demo shows.
- One sentence on prereqs to re-record (e.g., "needs `vhs` v0.7+ and `python -m env_optimiser` on PATH").
- One sentence on the expected outcome.

## Hard rules

- **Quality gates first.** Before writing `pr-description.md`, run the project's quality gate command (`npm test`, `pytest`, `bats tests/`, etc.). If gates fail, STOP. Do not write `pr-description.md`. Update `<worktree>/AGENT.md` with the failing-gate state and exit. The bench scores `pr-description.md` written + gates red as score = 0 (the `pr_only_when_green` second gate).
- **Demo source greppably exercises the ACs.** Each WI's `then`-clause keywords appear in `source.<tape|spec.ts>`. The demo should walk the human through each AC's observable outcome, not the implementation.
- **No `gh pr create`.** The orchestrator owns it. The agent only drafts `pr-description.md`.
- **No queue mutation.** Do not touch `_queue/`. The orchestrator moves the manifest after this skill exits.
- **No notifications.** The orchestrator fires them.
- **Squash-merge stacked PRs is forbidden.** If `Parents:` is in your PR description, the merge will be `--merge`, not `--squash`. The bench's `merge_strategy_respected` criterion checks this.
- **Single-purpose tool whitelist.** You have `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Bash`. No `WebFetch`/`WebSearch` — the brain has documentation. If you need information, query the brain.

## Event-log entries to emit

- `reviewer.start`
- `reviewer.brain-query` (one per query)
- `reviewer.quality-gates-checked` (with pass/fail + command + exit code)
- `reviewer.demo-recorded` (with tool, source path, recording path, file size)
- `reviewer.pr-description-emitted` (with section count, body length)
- `reviewer.end`

## Benchmark suite

[`benchmarks/review-loop/`](../../benchmarks/review-loop/) — five fixtures (one per managed project), seven weighted criteria + two gates, pass threshold 0.7. Rubric locked in [`benchmarks/review-loop/scoring.ts`](../../benchmarks/review-loop/scoring.ts).

Gates (either failing → score = 0):
- `quality_gates_pass` — orchestrator-verified, never trust the agent's claim.
- `pr_only_when_green` — `pr-description.md` exists but gates failed → score = 0.

Weighted (sum = 1.0):
- `demo_recording_present` (0.15) — file exists, valid magic bytes, size > floor.
- `demo_exercises_acceptance_criteria` (0.20) — AC keyword presence in source.
- `pr_description_why_not_what` (0.20) — Why/What/How/Demo sections; Why ≥ 50 chars.
- `pr_description_length_floor` (0.10) — body > 300 chars.
- `pr_links_demo` (0.10) — markdown link to `.forge/demos/<id>/`.
- `merge_strategy_respected` (0.15) — stacked-PR squash detection.
- `brain_consulted` (0.10) — ≥ 1 brain read in tool-use telemetry.

## Process

1. **Brain query first.** Always-relevant themes plus project-specific reviewer themes.
2. Read the manifest and every WI in `<worktree>/.forge/work-items/`. Confirm all are at `status: complete`. If any is not, STOP and emit a `reviewer.end` with `result_subtype: incomplete`.
3. Run the project's quality gate command. Capture the exit code.
4. **If gates fail:** update `<worktree>/AGENT.md` with the failure state and exit. Do not write `pr-description.md`. Do not record a demo. Emit `reviewer.end` with `result_subtype: gates-red`.
5. **If gates pass:**
   a. Decide the demo tool: browser/canvas → Playwright; otherwise → VHS.
   b. Write `<worktree>/.forge/demos/<initiative-id>/source.<tape|spec.ts>`. Make sure each WI's AC `then`-clause keywords appear textually in the source.
   c. Run the recorder to produce `recording.<mp4|webm|gif|trace.zip>` in the same directory.
   d. Write `README.md` with the one-paragraph context.
   e. Compose `<worktree>/.forge/pr-description.md` per the section template above.
6. Emit `reviewer.end` with `output_refs: [pr-description.md, demos/<id>/]`.

## Constraints

- **Self-sufficient demo.** A human running the recording (or a CI replay) should reproduce the demo without consulting the agent. The `README.md` carries the prereqs; the source script carries the steps.
- **Stage 2 is deferred.** This skill does not handle interactive human review, send-back loops, or developer-loop re-dispatch. That is a separate plan.
- **Demos prove behaviour, not implementation.** The recording walks the human through observable acceptance-criteria outcomes — not the code path.
