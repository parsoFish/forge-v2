---
title: File-based state machine for queue management
description: _queue/{pending,in-flight,ready-for-review,done,failed}/ directories with atomic mv as the transition primitive. The filesystem IS the protocol.
category: pattern
keywords: [state-machine, atomic-mv, queue, directories, pending, in-flight, file-protocol]
created_at: 2026-05-04T17:55:00Z
updated_at: 2026-05-04T17:55:00Z
related_themes: [unattended-scheduler, crash-recovery-heartbeat, markdown-artifact-flow]
---

# File-based state machine for queue management

Forge's initiative queue is five directories under `_queue/`:

```
_queue/
├── pending/             # waiting to be claimed
├── in-flight/           # currently being worked
├── ready-for-review/    # surfaced for human review (notification fired)
├── done/                # merged + reflected
└── failed/              # exceeded retry/iteration budget; needs human triage
```

Each directory holds initiative manifests — markdown files with YAML frontmatter (`initiative_id`, `project`, `created_at`, `claimed_at`, `claimed_by`, `iteration_budget`). The `cost_budget_usd` field was removed by CONTRACTS.md C19 (2026-05-23).

State transitions are atomic file moves: `mv pending/<id>.md in-flight/<id>.md`. On a single filesystem, `mv` is atomic — that *is* the entire claim mechanism. No DB, no IPC, no daemon protocol.

Inspectable: `ls _queue/` is the entire system state. Recoverable: `git worktree list` + `_queue/` listing tells you what's running and what's stuck.

Trade-off: assumes single filesystem (no NFS-style network mounts). No priority queue or dedup — pending items processed in filesystem order. Adequate for the unattended cadence.

## Sources

- [`adr-011-unattended-scheduler.docs.md`](../../_raw/docs/adr-011-unattended-scheduler.docs.md) — primary source.
- [`adr-012-crash-recovery.docs.md`](../../_raw/docs/adr-012-crash-recovery.docs.md) — recovery semantics.

## Related

- [Theme: Unattended scheduler](./unattended-scheduler.md) — the consumer.
- [Theme: Crash recovery via heartbeat](./crash-recovery-heartbeat.md) — what protects in-flight integrity.
