---
title: >-
  Forge as-built — 5 wired phases + hand-run architect, PM/reflector-only
  brain-first, ~4,400 LOC, a real resilience layer
description: >-
  Honest snapshot of forge's actual structure (not the stated ideal). Architect
  is out-of-cycle Path-B; brain-first is enforced only for PM+reflector;
  orchestrator is ~4,400 LOC not 300; the classifier/auto-retry resilience layer
  is the most mature subsystem; queue state is not ground truth.
category: reference
keywords:
  - as-built
  - architecture
  - path-b-architect
  - brain-first-narrowed
  - orchestrator-loc
  - failure-classifier
  - auto-retry
  - queue-not-truth
  - doc-drift
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-16T00:00:00.000Z
related_themes:
  - six-phases-of-forge
  - forge-project-onboarding-contract
  - unattended-scheduler
  - simplicity-as-architecture
---

# Forge as-built (honest snapshot)

Recorded against the actual code at the close of the trafficGame arc, not
against ARCHITECTURE.md / PRINCIPLES.md ideals. Where the two differ, the
docs should be reconciled to this (closure goal G7).

- **5 wired phases + 1 hand-run.** PM, developer-loop, review-loop,
  reflection run inside `runCycle`. The **architect is out-of-cycle** —
  a SKILL.md *pattern* invoked manually plus manual manifest authoring
  ("Path-B"). `brain-ingest` is likewise not invoked; the reflector
  direct-writes themes. "Six equal phases" is a mental model, not the
  runtime shape.
- **Brain-first is narrowed by design.** Runtime-enforced for PM
  (throws on 0 brain reads) and reflector (log-and-continue);
  **deliberately removed** from dev-loop (F-34) and reviewer (F-41) as
  net-negative overhead. CLAUDE.md's universal brain-first rule is now
  contradicted by code on purpose.
- **Orchestrator ≈ 4,400 LOC**, not ADR-011's ~300. Most is
  invocation-contract files shared bench↔live — a defensible
  single-source-of-truth tradeoff that nonetheless breaks the
  "cap orchestrator surface" rule. State the real number.
- **The resilience layer is the most mature subsystem** and is absent
  from the original design: an 11-mode failure classifier, bounded
  auto-retry (≤2, anti-thrash), trivial-pass guard, scratch-wipe
  between WIs, worktree preservation, node_modules symlink, and
  initiative-level dependency scheduling.
- **Queue state ≠ ground truth.** `_queue/done/` can hold unmerged or
  partially-merged initiatives; the JSONL event log is closer to truth.
- **Known stale surface (defects, not understanding gaps):**
  `PROMPT.md.tmpl` still threatens a removed brain-first gate; a dead
  `pm-hallucinated-paths` classifier mode; two coupling/path validators
  (one live, one dead); reviewer SKILL.md mandates 9 events, 4 emitted.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: F-24…F-44 + audit basis.
- [`retro.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/retro.md) — §4 as-built, §5 inconsistencies I1–I6, §6 goals G3/G5/G7.

## See also

- [[six-phases-of-forge]] — the idealised model this corrects.
- [[forge-project-onboarding-contract]] — what this architecture is held to.
- [[unattended-scheduler]] — the subsystem that grew the resilience layer.
- [[simplicity-as-architecture]] — simplicity is key — every "no" defends it.
