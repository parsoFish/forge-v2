---
title: Ralph agent hallucinates cwd at the start of each new iteration, burning reads before recovering
description: WI-5 (Cycle 7) showed the ralph agent beginning each of 4 consecutive iterations by reading from a wrong/hallucinated path (/workspace/, /workspaces/fw-ai-product-development/, /workspaces/claude-trail/, /) before issuing pwd + ls and recovering to the real worktree. 4 wasted iterations, 83 total reads, 0 testRuns recorded.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Ralph cwd hallucination per iteration

## Observation

WI-5 of Cycle 7 (`INIT-2026-05-26-claude-trail-verify-cascade-v2`) took 5
iterations (gate failure: `Could not find 'tests/filter-cli.test.ts'` × 4).
Inspection of tool paths per iteration:

| Iter | First Read path | Recovery path |
|---|---|---|
| 1 | `/workspace/AGENT.md` | `find /home/parso → /home/parso/forge/_worktrees/.../AGENT.md` |
| 2 | `/workspaces/fw-ai-product-development/.forge/work-items/WI-5.md` | `pwd && ls -la` |
| 3 | `/workspaces/claude-trail/AGENT.md` | `pwd && ls .` |
| 4 | `/AGENT.md` | _(all paths wrong, 32 bash calls total)_ |
| 5 | _(correct path from start)_ | gate.pass |

Each iteration's first tool call was a `Read` to a path that does not exist
in the current environment. The agent then issued filesystem discovery
commands (`ls /`, `find /home`, `pwd`, `ls -la`) and eventually located the
real worktree at `/home/parso/forge/_worktrees/<initiative-id>/`.

WI-5 total: **83 reads, 32 bash calls, 0 testRuns** across 5 iterations.

## Why this happens (hypothesis)

The ralph agent's system prompt or context does not carry a stable, explicit
`cwd` anchor. Prior context from other WIs (or from a sandboxed coding
environment the model was previously trained on) bleeds into the first read
of each iteration. The model tries the "expected" path first, fails silently
(no error raised by `Read` on wrong path), then falls back to discovery.

## Why this matters

1. Each recovery burns ~8 reads + 4–8 bash calls before reaching productive
   work.
2. In WI-5's case, the recovery didn't always produce the test file before
   the gate ran — leading to 4 consecutive gate failures (`Could not find
   'tests/filter-cli.test.ts'`).
3. `testRuns: 0` across 5 iterations (83 reads, 32 bash) suggests the
   agent never successfully ran `node --test` against the new file as a
   local sanity check before the gate — likely because the working-directory
   confusion persisted into the write/run phase.

## Recommended fix

1. **Inject explicit absolute path into ralph's start context.** The ralph
   system prompt should include: `Your working directory is <absolute-path>.
   All file reads and writes MUST use this prefix.`
2. **Fail-fast on wrong-path reads.** If the first `Read` in an iteration
   returns a "file not found" error, the orchestrator should log a
   `cwd-confusion` event and inject a correction before iteration 2.
3. **Require testRuns ≥ 1 per iteration.** If a WI spec requires creating
   a new test file, the iteration metadata should fail a liveness check if
   `testRuns == 0`, triggering a warn event.

## Sources

- `_logs/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2/events.jsonl` — WI-5 iteration tool_use metadata
- `brain/_raw/cycles/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2.md` — cycle archive
