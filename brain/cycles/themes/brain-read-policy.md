---
title: >-
  Brain-read policy — planner reads, executor/reviewer don't, all reads
  index-guarded
description: >-
  Operator-confirmed. The architect/PM MUST read the brain (antipatterns +
  historical work-sizing inform initiative slicing). The dev-loop and reviewer
  MUST NOT read the forge brain — intent is wholly captured in the work items
  the planner authored — but MAY read the project's Brain 3 for supplemental
  context (ADR 018 amendment). Every brain read must use the
  INDEX/category-index/profile metadata, not expensive full scans.
category: decision
keywords:
  - brain-read
  - policy
  - planner-reads
  - dev-loop-no-brain
  - reviewer-no-brain
  - index-guardrail
  - navigation-metadata
  - F-34
  - F-41
  - single-source-of-intent
created_at: 2026-05-16T00:00:00.000Z
updated_at: 2026-05-26T00:00:00.000Z
related_themes:
  - brain-first-research
  - reactive-constraint-stripback-arc
  - karpathy-three-layer-wiki
  - forge-current-architecture-as-built
---

# Brain-read policy

The universal "every skill reads the brain first" mandate is **wrong**;
the operator confirmed the F-34/F-41 strip-backs and restated the policy
positively.

**Who reads.** The **architect/planner (PM)** must read the brain. It
needs the antipatterns (to avoid known traps) and the historical
work-sizing / cost-per-WI evidence (to slice an initiative into
realistically-sized work items). Planning is exactly the phase where
brain knowledge changes the output. The **reflector** reads (and
writes) by definition.

**Who does not.** The **dev-loop must not** read the *forge* brain
(Brains 1+2) — the intent, constraints and acceptance criteria are
*wholly captured in the work item* the planner authored; a second
forge-brain pass is cost paid twice and a source-of-truth split. The
**reviewer must not** read the forge brain for the same reason: the
initiative's intent is wholly captured in the manifest + the work-item
set the planner produced; the reviewer judges the branch against *that*,
not against the brain. This is why the runtime brain-first gate is
enforced only for PM (throw) and reflector (log-and-continue) and was
deliberately removed from dev-loop/reviewer.

**Amendment 2026-05-26 (ADR 018 three-brain model).** The dev-loop and
reviewer **may** read **Brain 3** — the cycle's project brain at
`projects/<name>/brain/` (present in the worktree). Now that Brain 3 is
scope-clean (project-only, no forge-theme pollution), the original
"don't risk an executor reading a forge theme and going off-spec"
rationale no longer applies. Brain 3 is *supplemental context* (project
file layout, testing norms); the WI/manifest remains the single source
of *intent*. Advisory, not mandatory — no runtime gate added.

**How reads are bounded (guardrail).** Every permitted brain read must
go through the built navigation metadata first — `INDEX.md`, the
category indexes (`cycles/{patterns,antipatterns,...}.md`), and
`projects/<name>/brain/profile.md` — and only then drill into a specific theme
and its raw source. Full-tree scans / grep-the-world are the expensive
antipattern the index layer exists to prevent. Open implementation
gap: `brain-index.ts` is module-cached, so a long `forge serve` process
sees stale indexes until restart — invalidate per cycle or document.

Net: **one source of intent per phase.** Planner ← brain. Executor ←
work item. Reviewer ← manifest + work-item set. Reflector ↔ brain.

## Sources

- [`2026-05-16_trafficgame-arc-reflection.md`](../_raw/2026-05-16_trafficgame-arc-reflection.md) — cycle archive: F-34/F-41 strip-backs + operator confirmation.
- [`architecture.md`](../../../_logs/2026-05-16_trafficgame-arc-reflection/architecture.md) — §F brain read/write topology + the index-guardrail caveat.

## See also

- [[brain-first-research]] — the universal mandate this supersedes.
- [[reactive-constraint-stripback-arc]] — why the dev/reviewer brain gate was removed.
- [[karpathy-three-layer-wiki]] — the index/metadata the guardrail relies on.
- [[forge-current-architecture-as-built]] — forge as-built — 5 wired phases + hand-run architect, pm/reflector-only brain-first, ~4,400 loc, a real resilience layer.
