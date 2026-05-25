---
title: Five of six WIs completed in exactly one iteration — sharp-gate pattern working as designed
description: WI-1 through WI-4 and WI-6 each completed in 1 iteration with gate.expected-fail → gate.pass sequence. This is the baseline delivery profile for new-file WI work in claude-harness when cwd is stable and scope is unambiguous.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# 5/6 WI single-iteration delivery — sharp-gate baseline confirmed

## Observation

Cycle 7 (`INIT-2026-05-26-claude-trail-verify-cascade-v2`) ran 6 ralph loops:

| WI | Iterations | Gate sequence | testRuns |
|---|---|---|---|
| WI-1 | 1 | expected-fail → pass | 2 |
| WI-2 | 1 | expected-fail → pass | 1 |
| WI-3 | 1 | expected-fail → pass | 2 |
| WI-4 | 1 | expected-fail → pass | 3 |
| WI-5 | 5 | expected-fail → fail × 4 → pass | 0 |
| WI-6 | 1 | expected-fail → pass | 1 |

WI-1–4 and WI-6 show the canonical sharp-gate pattern:
1. Gate runs immediately on a file that doesn't exist yet → `gate.expected-fail`.
2. Agent creates the file + implementation.
3. Gate runs on the new file → `gate.pass`.
4. Ralph exits with `quality-gates-pass` in 1 iteration.

The `testRuns` count matches the number of test executions the agent ran
locally to validate before the gate.

## Why WI-5 is the outlier

WI-5 (CLI wiring) suffered cwd hallucination (separate theme:
`2026-05-25-ralph-cwd-hallucination-per-iteration.md`). Without that issue,
it would likely have been a 1-iteration delivery. The sharp-gate pattern
itself worked correctly for WI-5 in iteration 5 once the agent had the right
path.

## Significance for sizing

The single-iteration delivery rate for new-file WI work is now confirmed
across two cycles:
- Cycle 6: 3/3 WIs in 1 iteration.
- Cycle 7: 5/6 WIs in 1 iteration (WI-5 is the sole anomaly, cwd-caused).

PM estimates of "2 iterations" per WI are conservative — when the agent
has correct cwd and unambiguous scope, 1 iteration is the norm. This should
inform future WI iteration budget settings: a sharp-gate WI targeting a
single new file typically needs `estimated_iterations: 1`, not `2`.

## Sources

- `_logs/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2/events.jsonl` — all ralph.end metadata
- `brain/_raw/cycles/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2.md` — cycle archive
