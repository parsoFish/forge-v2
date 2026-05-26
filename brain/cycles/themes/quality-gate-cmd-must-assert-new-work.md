---
title: Quality-gate-cmd must assert NEW work, not just "passive command exits 0"
description: Per-WI quality_gate_cmd patterns like `go test ./pkg/...` or `npm test` can false-pass when the dev-loop adds zero test coverage — the test runner exits 0 with "no tests to run". The gate must include a sanity check that the expected new artefact (test file, coverage delta, or named function) actually landed.
category: antipattern
created_at: 2026-05-23T11:58:00Z
updated_at: 2026-05-23T11:58:00Z
related_themes:
  - file-isolation-constraint-enables-single-iteration
  - pr-as-sole-review-window
---

# Quality-gate-cmd must assert NEW work

## Sources

- `_logs/2026-05-23T11-43-25_INIT-2026-05-23-release-def-substrate-gates/events.jsonl` — 6 WIs all reported `quality-gates-pass`, $2.62 spent. Actual `git diff main..HEAD` showed only 57 lines added to one existing Go file. Zero test files, zero docs, zero examples.
- The unifier's `pr-not-self-contained` gate caught the gap at `_logs/.../events.jsonl:developer-unifier` events — 2 iterations both failed, cycle abandoned.

## What happened

Initiative INIT-2026-05-23-release-def-substrate-gates declared per-feature
`quality_gate_cmd: [go, test, ./azuredevops/internal/service/release/..., -run, TestReleaseDefinition]`.
PM decomposed into 6 WIs each inheriting the gate. Each WI's Ralph:

1. Read the manifest + WI spec.
2. Wrote a small chunk of code (FEAT-2's `preDeploymentGatesSchema()` only — 57 lines total across the run).
3. Ran `go test ./...release/... -run TestReleaseDefinition`.
4. The command exited 0 with "no tests to run, no files in ./..." — there were never any `TestReleaseDefinition*` functions to match.
5. The dev-loop's gate-evaluator saw exit 0 ⇒ `gate.pass`.

All 6 WIs reported `iters=1 · quality-gates-pass` ⇒ dev-loop "succeeded". The
unifier sub-phase then caught the substantive failure (`pr-not-self-contained` — DEMO.md absent because there's nothing to demo).

## Why this pattern is dangerous

The dev-loop spent $2.62 on 6 Ralph runs that all "passed" structurally but
delivered ~10% of the actual acceptance criteria. The unifier caught it, but
only at the very end of the cycle, after most of the budget was spent.

Generalised antipattern: **passive command-line gates can be silent on
absence of work**.

| Tool | Silent-pass case |
|---|---|
| `go test ./pkg/... -run TestX` | exits 0 when no test functions match `TestX` |
| `npm test` (jest, vitest, mocha) | exits 0 when no test files match the runner's pattern |
| `pytest tests/` | exits 5 when no tests collected — but only if `--strict` config is on |
| `cargo test` | exits 0 with "running 0 tests" if no `#[test]` fn in the named module |
| `bun test` | exits 0 on empty match |
| `bats tests/` | exits 0 when no `.bats` file in path |

## Mitigations

The dev-loop's quality_gate_cmd evaluator (or the PM/architect emitting it)
should adopt at least one of:

1. **`verification_artifact` existence check** — C5 already specifies the
   field; require it for any WI whose `quality_gate_cmd` is a passive
   runner. Gate-evaluator's pre-flight: `existsSync(verification_artifact)`
   AND `git diff --name-only main..HEAD` includes it.
2. **Verbose-output assertion** — gate command becomes
   `go test -v ./...release/... -run TestReleaseDefinition 2>&1 | grep -E '--- PASS:.*TestReleaseDefinition'` — exit 0 only if ≥1 PASS line for the
   expected test prefix.
3. **Coverage delta** — for projects with a coverage tool, require
   `cov_delta > 0` since `main`.
4. **The unifier's `pr-not-self-contained` gate** stays the load-bearing
   late-stage catch (validated by this cycle). Even with #1-#3 above, the
   unifier sticks around as the safety net.

## How to apply

When the architect drafts per-feature `quality_gate_cmd`, pair it with a
per-feature `verification_artifact` path. When the PM emits per-WI
`quality_gate_cmd`, require either:
- `creates: [<file>]` per C5, OR
- `verification_artifact: <file>` AND the gate's grep filter named.

A small refinement to the dev-loop's gate-evaluator could enforce this at
gate-time: if `quality_gate_cmd` is a passive runner AND no
`verification_artifact` was created in the diff, treat the gate as
indeterminate (not pass).

## See also

- `file-isolation-constraint-enables-single-iteration` — the related
  one-file-per-WI pattern that DOES correlate with single-iteration success.
- [[pr-as-sole-review-window]] — the unifier's late-stage gate is the
  load-bearing catch.
