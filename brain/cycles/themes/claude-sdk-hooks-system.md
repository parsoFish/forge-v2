---
title: Claude Agent SDK hooks system
description: >-
  PreToolUse / PostToolUse / SessionStart / UserPromptSubmit lifecycle hooks.
  Inspect/modify tool calls, augment prompts, inject context, block dangerous
  operations.
category: pattern
keywords:
  - hooks
  - sdk
  - pretooluse
  - posttooluse
  - sessionstart
  - userpromptsubmit
  - lifecycle
  - permissions
created_at: 2026-05-04T18:00:00.000Z
updated_at: 2026-05-04T18:00:00.000Z
related_themes:
  - claude-agent-sdk
  - claude-sdk-subagents
---

# Claude Agent SDK hooks system

The SDK exposes lifecycle hooks that callers register in `options.hooks`. Each hook is a callback that returns `{ continue, hookSpecificOutput }` to permit, block, or inject context.

```ts
{
  hooks: {
    PreToolUse:        [{ matcher: "Bash", hooks: [async (input) => { /* permit/block/ask */ }], timeout: 10 }],
    PostToolUse:       [{ hooks: [async (input) => { /* log duration, write JSONL */ }] }],
    SessionStart:      [{ hooks: [async (input) => ({ /* inject project rules */ })] }],
    UserPromptSubmit:  [{ hooks: [async (input) => ({ /* augment prompt with context */ })] }]
  }
}
```

Forge v2 uses hooks for:

- **Brain-first enforcement** — a `PreToolUse` hook can verify a `brain-query` event was emitted before allowing other skill actions (event-log enforcement per ADR 010).
- **Cost / iteration tracking** — `PostToolUse` writes JSONL events.
- **Context injection** — `SessionStart` can attach project-specific rules from `<project-repo>/brain/profile.md`.
- **Auto-format / lint** — `PostToolUse` runs prettier/tsc after a Write.

## Sources

- [`claude-agent-sdk-typescript.docs.md`](../../_raw/docs/claude-agent-sdk-typescript.docs.md) — hooks reference.

## See also

- [[claude-agent-sdk]] — runtime context.
- [[claude-sdk-subagents]] — claude agent sdk subagents.
- [[brain-first-research]] — enforced via hooks.
