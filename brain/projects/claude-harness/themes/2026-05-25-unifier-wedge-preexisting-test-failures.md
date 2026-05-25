---
title: Unifier wedged 15 iterations on pre-existing test failures outside WI scope
description: The unifier's npm test initiative gate failed on 4 pre-existing test failures (missing _pr-metadata.json fixture). Per-WI gates (scoped to new test files) passed. Unifier diagnosed the root cause correctly but could not fix it — 15 iterations consumed at $9.90 total before budget exhaustion.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Unifier wedge — pre-existing test failures outside WI scope

## Observation

Cycle 6's three ralph loops (WI-1, WI-2, WI-3) each completed in 1 iteration
using scoped gates:

```
WI-1: node --test tests/probe-core.test.ts   → 8 pass
WI-2: node --test tests/probe-format.test.ts → 3 pass
WI-3: node --test tests/probe-cli.test.ts    → 3 pass
```

The unifier gate runs `npm test` (full suite). At cycle start, the project had
pre-existing test failures: `_pr-metadata.json` was absent from
`tests/fixtures/cycle-INIT-FIXTURE-1/.forge/`, causing 4 tests in other
test files to fail.

Unifier iteration 1 (cost: $0.32):
> "The tests are expecting a `.forge/_pr-metadata.json` file in the fixture that doesn't exist. These are pre-existing tests failing, not new tests."

Unifier then spent 14 more iterations ($0.66 avg each) attempting to fix
the same root cause, all failing at `npm test`. After 15 iterations,
`stop_reason: iteration-budget` fired.

**Total unifier cost: $9.90 of the $13.65 cycle total.**
**Budget: $4.00. Overspend: $9.65.**

## Root cause

1. **Gate asymmetry**: per-WI gates scope to new test files; unifier gate
   runs full suite. A pre-existing failure invisible to WI gates is always
   visible to the unifier gate.

2. **No "pre-existing failure" escape hatch**: the unifier has no mechanism
   to say "I've diagnosed these as pre-existing failures outside my scope;
   proceeding anyway." It retries until budget exhaustion.

3. **No wedge detection for this failure class**: the wedge-detector fires on
   silent repeats (same output, no progress). The unifier produced different
   bash commands each iteration, so the detector did not fire. It *was*
   wedged in the functional sense (same root cause, no fix possible) but not
   detected structurally.

## Failure mode anatomy

```
Iteration  1: diagnose → pre-existing failures found
Iteration  2: attempt fixture fix → npm test still fails
Iteration  3: git stash → npm test on main → still fails? (pre-existing on main too)
...
Iteration 15: budget exhausted → unifier.failed
```

The feature itself shipped correctly (probe subcommand works, 14 new tests
pass). The unifier failure moved the cycle to `pr-open` with the unifier
marked as failed — but the PR was eventually merged.

## Recommended fixes

1. **Unifier should baseline `npm test` on `main` before attempting fixes**.
   If `npm test` fails on main too, the failures are pre-existing — mark them
   as baseline failures and don't count them against the initiative gate.

2. **Alternatively**: the unifier initiative gate should compare `npm test`
   output against a baseline (captured at cycle start or from the last
   known-good commit). Only newly introduced failures count.

3. **Wedge detection for "same error, different attempts"**: if the unifier
   produces N consecutive gate failures with identical `npm test` failure
   count and identical failing test names, declare a wedge after N=3.

## Sources

- `_logs/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade/events.jsonl` — 15 unifier.gate.initiative-failed events
- `brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md` — cycle archive
