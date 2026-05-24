---
title: Single-WI manifests produce single-pass delivery — no dual-boundary pattern
description: Cycle 5 (format-flag) is the first cycle since cycle 2 with only one boundary snapshot. The distinguishing factor is scope: 1 WI with 1 gate. Cycles 3 and 4 (multi-WI or retry context) both showed the dual-boundary two-pass pattern. Single-WI scope correlates with single-pass delivery.
category: pattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Single-WI scope produces single-pass delivery

## Observation

Boundary counts by cycle:

| Cycle | WI count | Boundaries | Pattern |
|-------|----------|------------|---------|
| 1 (scaffold) | many | 1 | single-pass |
| 2 (cost-only) | 2 | 1 | single-pass |
| 3 (git-enrich) | 4 | 2 | two-pass |
| 4 (since-flag) | 1 (retry context) | 2 | two-pass |
| 5 (format-flag) | 1 | 1 | single-pass |

Cycle 5 produced exactly 1 boundary snapshot (`e987c6d`), suggesting the dev-loop completed the feature without a reviewer send-back or self-detected gap that triggered re-entry.

## Why single-WI correlates with single-pass

- No inter-WI integration surface to mishandle.
- Gate condition covers exactly the thing being built — no ambiguity about which WI "owns" the gate.
- Dev-loop cannot complete WI-1 and accidentally skip WI-2 (there is no WI-2).

Cycle 4 had 1 WI but still produced 2 boundaries. The distinguishing factor is that cycle 4 was a retry cycle with residual complexity from the prior failure. Cycle 5 is a clean fresh single-WI from a stable repo state.

## Hypothesis

The `dual-boundary` pattern (`2026-05-25-dual-boundary-two-pass-delivery.md`) emerges when the feature has complexity that requires a "messy first pass + clean second pass". A 1-WI fresh cycle lacks that complexity spike — the agent navigates to the correct solution in a single pass.

## When to apply

When a cycle's manifest can be expressed as 1 WI with 1 integration-level gate, prefer that decomposition. Single-pass delivery is lower cost and produces cleaner history.

## Caveat

Single-pass delivery with 100% safety-net rate (cycle 5) still lacks semantic self-commits. Scope reduction helps delivery shape but does not address the commit hygiene issue.

## Sources

- `brain/_raw/cycles/INIT-2026-05-25-claude-trail-format-flag.md` — cycle 5 archive
- `_logs/INIT-2026-05-25-claude-trail-format-flag/events.jsonl` — cycle 5 event log
- `brain/projects/claude-harness/themes/2026-05-25-dual-boundary-two-pass-delivery.md` — dual-boundary pattern for contrast
