# S6B — Reflect: slash-command UX + recap surface

> Stage S6B of the 2026-05-20 refinement batch. Lands the operator UX side
> of reflect: the `/forge-reflect <id>` slash command renders an inline
> recap + numbered questions + answer prompt, writes
> `_logs/<id>/user-feedback.md` in the SKILL's canonical format,
> **auto-invokes `forge reflect <id> --rerun`** per C9, and the orchestrator
> writes `_logs/<id>/recap.md` post-cycle. S6A (lint trigger + retention
> tagging) and S6B (this stage) are intentionally split per C18c — S6A
> ships curation infra, S6B ships operator-facing surface.

## Architecture

### CLI-module pattern (`orchestrator/forge-<phase>-cli.ts`)

Per council 06 `dx:01-cli-module-pattern`. All slash-command CLI modules
follow this shape:

```ts
// orchestrator/forge-<phase>-cli.ts
export function render(input: {...}): string
export async function writeOutput(input: {...}): Promise<{...}>
```

`render()` is **pure** — given inputs (file paths + cycle id), returns a
markdown string. No side effects. Trivially unit-testable.

`writeOutput()` is the side-effect surface: writes the feedback file,
optionally invokes `forge reflect <id> --rerun`. Injectable deps for tests.

`orchestrator/forge-reflect-cli.ts` is the first concrete instance. Future
slash-command implementers (plan 02's `/forge-architect commit`, plan 05's
`/forge-review`) follow the same shape so test harnesses stay consistent.

## Canonical `user-feedback.md` format

Per `skills/reflector/SKILL.md` §"Operator handoff", the file is read by
the reflector's stage 3 (file-based handoff). Format chosen:

```markdown
# Reflection feedback — <cycleId>

## Answers to numbered questions

### 1. <question-1 text>
<operator's answer body>

### 2. <question-2 text>
<operator's answer body>

## Free-form feedback

<anything else for the brain — antipatterns observed, decisions to record, etc.>
```

Round-trip parseable: `parseFeedback()` extracts an ordered list of
`{ question, answer }` pairs from the `## Answers to numbered questions`
section and a `freeform` string from `## Free-form feedback`. Empty answers
are preserved (the operator may legitimately want to skip a question).

If no questions exist (the reflector wrote no `user-questions.md`), the
"Answers" section is omitted; only `## Free-form feedback` is written.

If the operator supplies no free-form text, the section is written as
`_(no additional feedback this cycle)_` — explicit-no-feedback is signal,
not silence.

## "Reflector hasn't run yet" handling

Plan 06 open question: what does `render()` return when
`_logs/<id>/user-questions.md` is missing?

**Decision: stub-render with explanation** (NOT block-with-error).

Rationale: the operator typing `/forge-reflect <id>` before the cycle
closes is a real flow (they're peeking ahead). Erroring out gives them no
recovery path. The stub-render explains the state ("reflector has not
emitted questions yet — either the cycle is still running or no questions
were warranted") and offers free-form feedback as a still-useful surface
("you can still record arbitrary feedback now; it will be appended to
this cycle's user-feedback.md").

If the **cycle dir itself** is missing, that's a different failure mode —
`render()` throws with `cycle log directory does not exist: <path>`.
The operator likely fat-fingered the id; failing fast is correct.

## `--rerun` semantics

Per C9: default-ON after slash-command writes `user-feedback.md`.

Implementation: `writeOutput()` (a) writes the file, (b) by default
invokes `forge reflect <id> --rerun` via an injectable `rerun` function
(default: spawns `runReflector` in-process from the CLI subcommand path).

`--no-rerun` override: passed as `{ rerun: false }` to `writeOutput()`
(the slash command's prompt collects this preference; absence means
default behaviour fires).

The `forge reflect <id> [--rerun]` subcommand on `orchestrator/cli.ts`:
- `forge reflect <id>` → prints the prompt the operator would see if they
  ran the slash command in their own session. Useful for terminal-only
  ops who don't want to launch a Claude session.
- `forge reflect <id> --rerun` → re-invokes `runReflector` against the
  closed manifest with the existing `user-feedback.md` as additional
  context. The reflector reads `user-feedback.md` natively (it's listed
  in the reflector's user prompt), so no contract change is needed — the
  re-invocation just walks the existing flow again.

## Recap surface (`_logs/<id>/recap.md`)

Written by `runReflector` (orchestrator-side, not agent-side) at the end
of the phase after retention tagging + lint trigger. **Always** written
on a successful reflector close — even minimal-clean cycles get a recap.

### Section ordering

```markdown
# Cycle recap — <initiativeId>

## Outcome

<one-line summary: status + project + cycle id>

## Stats

- Cost (total): $X.XX
- Duration: H:MM:SS or N seconds
- Send-back rounds: N
- Dev-loop iterations: N

## Themes written

- <relative path>: <title>
- ...

(or "_(no themes written this cycle)_")

## Brain gaps

- Closed (N): <ids>
- Outstanding (N): <ids>

## Lint

- Status: clean | flagged | skipped
- Findings: N error, N flag (if flagged)
- Report: _logs/<id>/brain-lint.md (if exists)

## Links

- Retro: _logs/<id>/retro.md
- Cycle archive: brain/_raw/cycles/<id>.md
- Manifest: _queue/done/<id>.md
```

Determinism: every value is pulled from disk (manifest, event log, themes
dir, archive frontmatter). No agent involvement. Re-running the recap
generator on the same cycle produces byte-identical output.

### Per C15a: NOT a PR comment

The recap lives at `_logs/<id>/recap.md`. Whether to post it as a PR
comment via `gh pr comment` is owned by plan 04's unifier (gated by a
manifest field `post_recap_to_pr: true`). S6B does NOT shell out to `gh`.

## `.claude/commands/forge-reflect.md`

**SANDBOX-BLOCKED.** Both `Write` and `Edit` against this path returned
"Permission denied" — the harness denies writes to `.claude/commands/` in
the worktree's mode. The intended replacement body is below; the operator
needs to apply it by hand (or unblock the path) before the new slash-UX
goes live. The CLI behaviour (`forge reflect <id>`, `forge reflect <id>
--rerun`, and the `forge-reflect-cli.ts` render/writeOutput pair) is fully
functional regardless — the slash command is just the prettier wrapper.

### Intended `.claude/commands/forge-reflect.md` (replace whole file)

```markdown
---
description: Reflection human moment — render recap + numbered questions, collect operator answers, auto-rerun reflector.
argument-hint: <initiative-id-or-handle>
---

# /forge-reflect <initiative-id>

> Human interaction moment — run in YOUR OWN Claude session. Forge never
> simulates this feedback in production (the bench simulator is bench-only).

Initiative / cycle: **$ARGUMENTS**

## What this command does (S6B contract)

1. **Render the in-session prompt** via
   `orchestrator/forge-reflect-cli.ts:render()` — header + numbered
   questions (from `_logs/<id>/user-questions.md`) + an empty
   `> Your answer:` block per question + free-form prompt + context links
   (retro / events / recap).
2. **Prompt the operator inline** for answers + free-form feedback.
3. **Write `_logs/<id>/user-feedback.md`** via
   `orchestrator/forge-reflect-cli.ts:writeOutput()` in the SKILL's
   canonical format (numbered answers + free-form section).
4. **Auto-invoke `forge reflect <id> --rerun`** per CONTRACTS.md C9 —
   default-on. The reflector re-runs against the closed manifest with the
   operator's answers as additional context.

`rerun: false` (pass to `writeOutput`) skips step 4 — the file is still
written, but no second reflector pass fires until the operator manually
runs `forge reflect <id> --rerun`.

## Run

Render the inline prompt:

\`\`\`bash
node --experimental-strip-types orchestrator/cli.ts reflect $ARGUMENTS
\`\`\`

Collect the operator's answers in this session, then write the feedback
file from the same session:

\`\`\`bash
node --experimental-strip-types -e "
import('./orchestrator/forge-reflect-cli.ts').then(async (mod) => {
  const res = await mod.writeOutput({
    cycleId: '$ARGUMENTS',
    answers: [/* one string per numbered question, in order */],
    freeform: '',
    /* rerun defaults to true per C9; pass rerun: false to override */
  });
  console.log('wrote:', res.feedbackPath, '| rerun:', res.rerun);
});
"
\`\`\`

After `writeOutput()` resolves, `_logs/$ARGUMENTS/user-feedback.md` is the
canonical record. Stop here — do not run a cycle from this moment.

## See also

- `skills/reflector/SKILL.md` §"Operator handoff" — canonical
  `user-feedback.md` format.
- `docs/planning/2026-05-20-refinement/06-reflect.md` §"Slash-command UX".
- `docs/planning/2026-05-20-refinement/CONTRACTS.md` C9, C15a.
```

### Verification of `argument-hint`

Pre-existing file (S1.1 already set this): `argument-hint: <initiative-id-or-handle>`. Confirmed in the current `.claude/commands/forge-reflect.md` frontmatter. The intended replacement above preserves it.

## Things deliberately NOT changed

- `runReflector` close-criterion. Recap is **additive** — it does not
  gate `reflection_status: 'closed'`. Per
  `feedback_reflection_close_criterion`, the criterion stays
  "no inconsistency + testable goals + honest as-built".
- Reflector's agent-side stage-2/3 file format. The canonical
  `user-feedback.md` format declared in this doc is the format the agent
  side **already reads**; we just made it write-side authoritative too.
- C8 sibling `lint_status` field. S6A's surface (kept).
- Retention tagging behaviour. S6A's surface (kept).
- `_logs/<id>/brain-lint.md` artifact. S6A's surface (kept; recap links to it).

## Taste calls

- **Stub-render over hard-error** when `user-questions.md` is absent.
  The operator's flow tolerates a too-early invocation.
- **Always emit recap.md** on successful reflector close, even with no
  themes / clean lint / zero send-backs. Discoverability beats brevity.
- **Cost / send-back stats sourced from event log**, not from `metrics.ts`,
  to keep the recap generator standalone (no cross-module dependency on
  the metrics summariser, which mostly exists for `forge metrics` aggregates).
- **`recap.md` is gitignored** — it lives under `_logs/<id>/` which is
  gitignored alongside the event log.
- **`--rerun` invocation is in-process** (re-calls `runReflector`),
  matching the S6A in-process lint trigger. No subprocess ceremony.
- **Operator's free-form-only flow** is preserved: even when no
  numbered questions exist, the slash command still surfaces the
  free-form prompt so the operator's voice always has a write path.

## Open / operator-pending

- Should recap.md auto-regenerate on `--rerun`? **YES** — same code path
  runs it again. Idempotent.
- Should the cost stat include the rerun's cost? Decided: NO. The recap
  reflects the closure pass; a rerun's cost is part of the next-cycle
  delta. (If we wanted cumulative, we'd add a `previous_recap` line —
  deferred.)
