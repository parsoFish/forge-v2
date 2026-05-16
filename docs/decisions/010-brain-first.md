# ADR 010 — Brain-first research

**Status:** Amended 2026-05-16 — brain-first is **narrowed to the
planner/architect and reflector**; the dev-loop and reviewer
deliberately do NOT read the brain (their intent is wholly in the
work items the planner authored). See the brain-read-policy theme
(`brain/forge/themes/brain-read-policy.md`) and F-34 / F-41.
**Date:** 2026-04-24 (amended 2026-05-16)

## Context

User principle 4: every component must use the brain as its first source of knowledge but must be able to research further when the brain is insufficient. Without enforcement, agents will reach for whatever's familiar (web search, training data, ad-hoc reading) and the brain stops being useful — exactly what happened in v1's early cycles before the wiki existed.

## Decision (amended 2026-05-16)

**The brain is read by the phases that *plan*, not the phases that
*execute*.** Original ADR mandated every skill brain-query first;
the trafficGame arc proved that net-negative for execution phases
(F-34/F-41 strip-backs were the right call). The policy now:

- **Architect / project-manager (the planner): MUST read the brain**
  first — antipatterns + historical work-sizing shape how an
  initiative is sliced. Runtime-enforced for PM (throws on 0 brain
  reads).
- **Reflector: reads (and writes) the brain** by definition.
- **Dev-loop and reviewer: MUST NOT read the brain.** The planner
  already encoded every relevant pattern/antipattern/convention into
  the work items; the WI (dev-loop) and the manifest+WI set (reviewer)
  are the **single source of intent**. A second brain pass is wasted
  cost and a source-of-truth split. No runtime brain gate for these.
- Permitted brain reads go through the navigation metadata
  (`INDEX.md`, category indexes, `profile.md`) — never full-tree scans.

`brain-query` still logs gaps; the reflector still reports gap counts.
Full rationale: `brain/forge/themes/brain-read-policy.md`.

## Consequences

**Positive:**
- The brain stays current — it's continuously stress-tested by every skill invocation.
- Gaps surface automatically.
- New users (and new skills) inherit the project's accumulated knowledge by default.

**Negative / accepted trade-offs:**
- Every skill pays a small upfront cost (one brain query). Mitigated by `brain-query` using a fast model (Haiku by default).
- Skills could lie about having queried the brain. Mitigated by event-log enforcement — the orchestrator can reject skill outputs that don't have a corresponding `brain-query` event.

## Alternatives considered

- **Optional brain consultation** — observed in v1 to drift to "never queried." Rejected.
- **Brain queries as a hook injected by the runner** — couples the runner to the brain too tightly; better to keep it in the skill where it's visible.

## References

- v1's `.forge/wiki/` — proved the wiki concept; this ADR makes consultation mandatory
- [Karpathy LLM-wiki gist](https://gist.github.com/karpathy/) — the philosophy
