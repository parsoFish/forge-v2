---
title: Per-WI scoped gate and unifier full-suite gate measure different things — failures compound silently
description: WI gates run node --test on a single new file; unifier gate runs npm test (full suite). A pre-existing failure invisible to WI gates is always visible at the unifier gate. The mismatch is structural — WIs pass, then unifier wedges on failures the WIs never saw.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Per-WI gate / unifier gate mismatch — structural observability gap

## Observation

Cycle 6 exposed a structural asymmetry in the two-level gate system:

**Level 1 — per-WI ralph gates** (scoped):
```
WI-1: node --test --experimental-strip-types tests/probe-core.test.ts
WI-2: node --test --experimental-strip-types tests/probe-format.test.ts
WI-3: node --test --experimental-strip-types tests/probe-cli.test.ts
```
Each gate runs only the test file the WI is expected to create. Passes if
the new file exists and its tests pass. Pre-existing failures in other test
files are invisible.

**Level 2 — unifier initiative gate** (full suite):
```
npm test   → runs ALL test files
```
Includes the new probe tests AND pre-existing tests. Any pre-existing failure
fails the unifier gate.

## Why this is structural, not incidental

The per-WI sharp gate pattern (documented in
`2026-05-25-sharp-gate-honoured-when-new-file-named.md`) is correct for
verifying a single WI's acceptance criteria. It must be scoped to the new
test file to enforce "file must exist" (the SHARP-GATE guarantee). It cannot
run the full suite without losing that guarantee.

The unifier gate runs the full suite to verify integration correctness across
all WIs. This is also correct — but it sees failures the WIs never saw.

The two gates measure different things. This is fine when the project has a
clean baseline. It becomes an antipattern when:
1. Pre-existing failures exist at cycle start.
2. The unifier cannot fix them (outside WI scope).
3. The unifier has no mechanism to distinguish "I introduced this" from
   "this was already failing."

## Impact in cycle 6

- 3 WIs completed in 1 iteration each: total ralph cost $1.08
- 15 unifier iterations on unfixable gate: total unifier cost $9.90
- Feature shipped correctly; failures were pre-existing and eventually fixed

## Structural fix options

**Option A — Unifier baselines `npm test` on main before fixing**
Capture failure list at cycle start. Only failures introduced by the branch
count against the gate. Pre-existing failures are ignored.

**Option B — PM declares the unifier gate explicitly in the manifest**
If the manifest specifies `quality_gate_cmd: node --test tests/probe-*.test.ts`
instead of defaulting to `npm test`, the unifier gate is also scoped and
the mismatch disappears. Loss: full-suite regression check is absent.

**Option C — Separate regression gate from initiative gate**
The initiative gate verifies "did this initiative's code work?"
A separate regression pass verifies "did anything break in the full suite?"
These are run at different times with different failure semantics.

## Sources

- `_logs/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade/events.jsonl` — gate event sequence
- `brain/_raw/cycles/2026-05-25T12-51-25_INIT-2026-05-25-claude-trail-verify-cascade.md` — cycle archive
- `brain/projects/claude-harness/themes/2026-05-25-sharp-gate-honoured-when-new-file-named.md` — sharp-gate pattern
