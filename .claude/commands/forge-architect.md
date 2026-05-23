---
description: Architect human moment — draft a PLAN.md the operator reviews before any manifest is queued (own session, out-of-cycle).
argument-hint: <project-name>
---

# /forge-architect &lt;project-name&gt;

> Human interaction moment — run in YOUR OWN Claude session. The architect
> is deliberately **out-of-cycle** (not wired into `runCycle`); this
> command is its first-class entry point. Forge never spawns an agent or a
> bench simulator for this in production.

This command has **no standalone procedure**. Invoke the **`architect`
skill** and follow [`skills/architect/SKILL.md`](../../skills/architect/SKILL.md)
**exactly** — it is the single source of truth for Reads, Writes, Process,
event-log entries, and constraints. Do not re-derive, paraphrase, or skip
any step. In particular:

- Process **step 2 (Brief + interview) is mandatory** — invoke
  `AskUserQuestion` ≥1 time before the council step, capped at 5 rounds.
- Process **step 3 (`architect-llm-council` via `runCouncil()`) is
  mandatory**, not optional — emit `architect.council-invoked` when you
  do it.

When the skill's contract is satisfied (roadmap rows updated +
`<project-repo>/_architect/<session-id>/{PLAN.md,PLAN.html}` written per C12 +
cwc Amendment 2), **stop** — do not start a cycle, do not promote draft
manifests to the queue. Print both paths and the next command:

    forge architect commit <session-id>  [--via-pr]

Target project: **$ARGUMENTS**
