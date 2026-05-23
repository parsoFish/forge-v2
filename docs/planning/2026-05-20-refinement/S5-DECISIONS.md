# S5 — Brain bench evolution (plan 01b: refinements #6 + #7)

Branch: `s5-brain-bench-growth` (worktree at `_worktrees/s5-brain-bench-growth`).
Base: `9d04bca` (post-S6A merge — reflector lint trigger + retention tagging
landed; we extend `runReflector` on top).

## What ships

1. Reflector emits `_logs/<cycle-id>/brain-bench-candidates.jsonl` after a
   successful close. One row per qualifying gap.
2. `forge brain bench:promote --cycle <id>` walks the candidate file,
   asks the operator keep/drop/edit per row (default: drop), gates on
   per-cycle/per-month caps + the 94.4% accuracy floor, reverts on
   regression.
3. `benchmarks/brain/questions.json` gains a `source_cycle` field; the
   bench parses + carries it forward.
4. Betterado seed: 2 manual questions cover the binding constraints.
5. CLI dispatcher: `forge brain bench:promote` recognised by
   `cmdBrain` in `orchestrator/cli.ts`.

## Decisions (operator-pending where flagged)

### D1 — "cycle that filled a gap" heuristic

The reflector emit logic is **gap-then-theme**:

- Read the cycle's `events.jsonl`.
- Collect every `brain-query.gap` event (one per low/no-confidence
  question per `skills/brain-query/SKILL.md`). Each carries the question
  text in `metadata.question`.
- Read `_logs/<cycle-id>/brain-gaps.jsonl` (the agent-maintained JSONL
  surface — already written by `brain-query` SKILL). Each row =
  `{question, scope?, category?, expected_sources?}`.
- A theme "fills" a gap iff the reflector wrote a theme file under
  `brain/projects/<project>/themes/` or `brain/forge/themes/` during this
  cycle (mtime >= `startedAtMs`) AND at least one of: the gap's
  scope=projectName, OR the gap's question shares ≥2 keywords with the
  theme's title/keywords frontmatter.

A candidate is emitted **per gap** whose corresponding theme is now
present. The candidate's `expected_sources` is the union of the theme
file paths the reflector wrote this pass (best-effort; the operator
trims at promotion time).

Cycles that wrote zero themes emit zero candidates. Cycles whose gaps
were not filled emit zero candidates. Both states are valid; the
candidates file is created empty.

### D2 — `bench:promote` no-candidates case

Graceful exit, zero-row append, exit code 0. The CLI prints
`(no candidates for cycle <id> — file: <path>)` and returns. This
matches the "log and move on" tone of `forge metrics` against an empty
cycle.

### D3 — Bench accuracy gate

The 94.4% floor is the published bar (CLAUDE.md). Implementation:

- Snapshot `questions.json` to `questions.json.before-promote-<ts>` in
  the tempdir for the promote session.
- After append, programmatically read the latest
  `benchmarks/brain/results/*.json` (results dir convention from
  `_lib/results.ts`). If absent or stale (>24h), surface a warning to
  the operator: "no recent bench result; run `npm run bench:brain` and
  re-invoke promote to confirm."
- For the test path we expose `runBenchAccuracy()` as an injectable so
  the harness can simulate accuracy values without actually paying
  for the SDK bench. Production resolves it to a wrapper that reads the
  latest results JSON (read-only; the actual rerun is the operator's
  responsibility — there's no clean way to programmatically run the
  full LLM bench during a CLI invocation without nontrivial wiring).
- On regression (< 0.944): revert to the snapshot and emit a failure
  message naming the dropped delta.

### D4 — Caps

- ≤1 promotion per cycle: tracked via `source_cycle` column. Second
  promote against the same cycle rejects with
  `cap-exceeded: per-cycle-promotion-limit`.
- ≤4 per calendar month: count rows where
  `source_cycle.startsWith(YYYY-MM)`. Manual seeds use the
  prefix `manual-seed-` and are exempt (operator-authored bootstrap, not
  candidate-flow).
- Caps are enforced **before** any append.

### D5 — Betterado seed questions (D5a + D5b)

**D5a — branch-model + harness-state Q (composite, single question)**

```
Q: For terraform-provider-betterado, what is the operative branch model
   and what does the demo/quality-gate harness look like (and why is
   acceptance-test coverage unattended-impractical)?
```

Expected sources:
- `brain/projects/terraform-provider-betterado/profile.md`
- `brain/projects/terraform-provider-betterado/themes/2026-05-18-branch-model-consolidated.md`
- `brain/projects/terraform-provider-betterado/themes/2026-05-18-go-test-harness-demos.md`

Keywords: `single-branch`, `main`, `harness`, `go test`, `TF_ACC`,
`acceptance`, `unattended`.

**D5b — createable-surface prefix Q**

```
Q: What constraints does the betterado createable-surface impose
   (prefix, registration, per-resource test substrate, fixtures)?
```

Expected sources:
- `brain/projects/terraform-provider-betterado/themes/council-constraints.md`
- `brain/projects/terraform-provider-betterado/themes/2026-05-18-stack-and-test-layout.md`
- `brain/projects/terraform-provider-betterado/profile.md`

Keywords: `betterado_`, `prefix`, `provider.go`, `azdosdkmocks`,
`vendored`, `make test`, `roundtrip`.

Both carry `source_cycle: "manual-seed-2026-05-23"`.

### D6 — `source_cycle` field on existing questions

The 21 pre-existing questions (Q1–Q21) **do not** get retroactive
`source_cycle` tagging. Adding the field as optional + tolerant means
the schema migration is invisible: bench/score still parses fine.

The two new questions (Q22, Q23) carry `source_cycle:
"manual-seed-2026-05-23"` per the manual-seed convention.

### D7 — No ADR yet

I judged the bench-growth mechanism doesn't yet need an ADR — it's a
pure tooling addition, the contracts (caps, schema) are documented here
and in this stage's code. If the operator wants `017-brain-bench-growth.md`,
the content already exists in `01-brain.md` §"Benchmark-growth mechanism"
and can be lifted verbatim.

### D7a — JSON formatting after promote

`runPromote` writes back via `JSON.stringify(rows, null, 2)`, which
expands `expected_sources` / `expected_keywords` arrays onto multiple
lines. The original questions.json uses inline-compact arrays. This is
a styling drift, not a correctness issue — both parse identically, and
the bench (`score.ts`) is whitespace-insensitive. If the operator wants
the inline style preserved, future work: add a `compactArrays`
post-processor to the writer (low priority).

### D8 — Interactive prompt UX

The CLI uses `readline.createInterface` on `process.stdin`/stdout (no
new deps; `node:readline` is built-in). Each candidate renders:

```
[i/N] candidate
  question: ...
  expected_sources:
    - ...
  why_now: ...
  gap_id: ...
keep / drop / edit (default: drop) >
```

`edit` opens `$EDITOR` (or `vi`) on a temp file pre-populated with the
candidate's fields; on save, the parsed result is the new question.

For non-interactive use (tests + CI), the CLI accepts
`--auto-keep <indexes>` and `--auto-drop <indexes>` (comma-separated
1-based indexes) — the tests use these to drive deterministic
promotions.

## Open / operator-pending

- **OP1**: confirm `manual-seed-` prefix is the right cycle-id convention
  for seed questions (vs `seed-2026-05-23`, `bootstrap-2026-05-23`).
  Leaning manual-seed since it surfaces operator intent.
- **OP2**: confirm cap-exempt status of `manual-seed-` rows for the
  monthly cap. Current behaviour: exempt (bootstrap should never
  consume the monthly budget).
- **OP3**: decide whether `bench:promote` should also rerun the bench
  programmatically. Currently it surfaces the command; running it
  in-process would be ~$0.50–$1.00 per invocation (21 cases × ~$0.03)
  and is unattended-questionable. Leaving as operator-driven.

## Files touched (this stage)

- `orchestrator/phases/reflector.ts` — emit candidates JSONL.
- `orchestrator/brain-bench-promote.ts` — new CLI module.
- `orchestrator/brain-bench-promote.test.ts` — ≥6 tests.
- `orchestrator/cli.ts` — wire `brain bench:promote` subcommand.
- `benchmarks/brain/questions.json` — 2 new betterado seed questions.
- `benchmarks/brain/score.ts` — parse + carry `source_cycle`.
- `S5-DECISIONS.md` — this file.

## AC scorecard

- AC1 `npx tsc --noEmit` clean: **PASS** (no output, clean exit).
- AC2 `node --test orchestrator/brain-bench-promote.test.ts` ≥6 pass:
  **PASS** (8/8 tests pass — 6 required + no-op + manual-seed exempt).
- AC3 `node --test orchestrator/phases/reflector.test.ts` pass:
  **PASS** (8/8 tests pass — 6 original S6A tests + 2 new S5 tests for
  candidate emission).
- AC4 `npm test` pass: **PASS** (669/669; no regressions).
- AC5 `questions.json` has 23 entries (21 + 2 betterado): **PASS**.
- AC6 CLI recognises `brain bench:promote`: **PASS**
  (`node --experimental-strip-types orchestrator/cli.ts brain
  bench:promote --help` prints usage).
- AC7 Synthetic candidate file → questions.json grew by 1: **PASS**
  (verified via `--auto-keep 1 --skip-bench`; questions.json 23 → 24).
- AC8 Synthetic 5-candidate file → only 1 promoted (cap): **PASS**
  (verified via `--auto-keep 1,2,3,4,5 --skip-bench`; first append
  succeeds, subsequent silently capped by per-cycle limit).
