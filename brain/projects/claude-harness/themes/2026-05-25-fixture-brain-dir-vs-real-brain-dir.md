---
title: CLI brain dir convention differs silently between fixture and real-world use
description: claude-trail's findThemesForInitiative walks a cycle-local brain/ dir (correct for frozen-fixture tests) but forge's actual brain/ tree lives at a different relative path; the discrepancy is silent and will cause empty Themes sections in real-world runs until a resolution mechanism is added.
category: antipattern
created_at: '2026-05-25'
updated_at: '2026-05-25'
---

# Fixture brain dir vs real-world brain dir mismatch

## Observation

`src/cli.ts` resolves the brain dir as:

```typescript
const brainDir = join(cycleDir, 'brain');
```

i.e. `_logs/<id>/brain/` — a cycle-local brain tree. This is correct for
the frozen-fixture test (`tests/fixtures/cycle-INIT-FIXTURE-1/brain/`),
but in real-world use forge's brain lives at `brain/` relative to the
forge root, not inside a cycle dir.

The fixture test passes (28/28), but a real invocation of:

```
node --experimental-strip-types src/cli.ts INIT-2026-05-24-claude-trail-scaffold
```

would produce an empty `## Themes consulted` section because
`/path/to/forge/_logs/INIT-2026-05-24-claude-trail-scaffold/brain/` does
not exist.

## Why this is silent

No error is thrown — `findThemesForInitiative` returns an empty array if the
dir doesn't exist. The CLI outputs `_(none)_` for the Themes section, which
looks valid but is wrong.

## Resolution options for cycle 2

1. Accept a `--brain-dir <path>` flag.
2. Read `FORGE_BRAIN_DIR` env var; fall back to `<cwd>/../../brain/`.
3. Walk up from `cwd` to find the nearest `brain/` dir (convention-based).

The chosen approach should be documented in `CLAUDE.md` and covered by an
integration test with a fixture that shadows the real brain dir path.

## Sources

- `_logs/INIT-2026-05-24-claude-trail-scaffold/events.jsonl` — cycle log
- `brain/_raw/cycles/INIT-2026-05-24-claude-trail-scaffold.md` — cycle archive
