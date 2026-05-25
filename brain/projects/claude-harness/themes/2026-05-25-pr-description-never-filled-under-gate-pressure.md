---
title: PR description placeholder never filled when unifier spends all iterations on gate failures
description: Cycle 7's unifier created a DEMO.md and pr-description.md with placeholders in iteration 1, then spent 15 subsequent iterations on npm test gate failures without ever returning to complete the PR description. PR opened with hollow <placeholder> strings.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# PR description never filled under unifier gate pressure

## Observation

Cycle 7 (`INIT-2026-05-26-claude-trail-verify-cascade-v2`) unifier iteration 1 tool sequence:

```
Bash:  mkdir -p /home/parso/forge/demo/INIT-2026-05-26-claude-trail-verify-cascade-v2
Write: /home/parso/forge/demo/INIT-2026-05-26-claude-trail-verify-cascade-v2/DEMO.md  (placeholder)
Write: /home/parso/forge/.forge/pr-description.md  (placeholder — "fills in after investigation")
Bash:  ls /home/parso/forge/.forge/
Read:  /home/parso/forge/.forge/pr-description.md
[→ npm test gate fails]
```

Iterations 2–16: exclusively focused on gate failure diagnosis and attempted fixes. PR description never updated. The merged PR (pending operator merge) will carry:

```markdown
## Why
<placeholder, fills in after investigation>

## What
<placeholder>

## How
<placeholder>
```

Additionally, the DEMO.md was created outside the project tree
(`/home/parso/forge/demo/...` rather than `projects/claude-harness/demo/...`).
This mirrors prior antipattern from Cycle 6 (`2026-05-25-six-requeue-silent-failure.md`
noted unifier confusion about forge vs project paths).

## Why this matters

1. PR description is the sole operator-facing artifact summarising the initiative.
   A hollow PR description means the operator must inspect git diffs to understand
   what landed.
2. The DEMO.md in `/home/parso/forge/demo/` is deleted in the effective diff
   (the diff shows it as a deletion), suggesting the unifier created it in
   the wrong place and the reviewer or a later diff stripped it.
3. The pattern suggests the unifier's iteration logic prioritises gate closure
   over PR description completeness — correct in principle, but when the gate
   is unfixable (pre-existing failures), the PR description never gets a
   second chance.

## Recommended fix

Unifier should write a **draft PR description first** (populated from WI
acceptance criteria + feature list), then attempt gate closure. If gate
closure fails after N iterations, the pre-written draft is still available
as a valid PR description artifact. Current behaviour: draft is written as
placeholder, then abandoned under gate pressure.

## Sources

- `_logs/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2/events.jsonl` — unifier iteration 1 tool_use metadata
- `_logs/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2/pr-description.md` — the hollow output
- `brain/_raw/cycles/2026-05-25T13-39-35_INIT-2026-05-26-claude-trail-verify-cascade-v2.md` — cycle archive
