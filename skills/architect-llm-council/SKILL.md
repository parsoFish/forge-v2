---
name: architect-llm-council
description: Multi-perspective critic chain (CEO/eng/design/DX) that auto-resolves mechanical questions about an initiative and surfaces only taste decisions for the user.
phase: architect
surface: interactive
model: claude-sonnet-4-6
---

# Architect — LLM Council

## Single responsibility

Take a draft initiative spec from the architect and run it through a chain of perspective-specific critics. Resolve mechanical issues automatically. Escalate only the *taste* decisions to the user. Inspired by gstack's `/autoplan`.

## Required first action

Invoke `brain-query` with:

- "What council critique patterns are in the brain — what do CEO/eng/design/DX critics typically catch?"
- "What antipatterns has the brain captured for the type of initiative being drafted?"

## Inputs

- A draft initiative spec (markdown + frontmatter, in-memory or path).
- Project context: `brain/projects/<name>/profile.md`, `projects/<name>/roadmap.md`.

## Outputs

- A revised initiative spec with mechanical issues fixed.
- A list of *taste decisions* surfaced to the user (each: question + 2-4 options + rationale per option).
- A chain-of-critique log appended to the architect's event-log entries.

## Event-log entries to emit

- `council.start` — chain begun.
- `council.critic` — one event per critic invocation (which critic, what it flagged).
- `council.auto-resolve` — one event per mechanical fix applied.
- `council.escalate` — one event per taste decision surfaced to the user.
- `council.end` — chain complete.

## Benchmark suite

[`benchmarks/architect/`](../../benchmarks/architect/) — shared with the architect skill.

## The critics

Each critic is invoked as a sub-agent via the Claude Agent SDK. Order matters:

1. **CEO critic** — does this initiative align with the project's stated direction? Is the value proposition clear? Is it the most leveraged thing right now?
2. **Eng critic** — are dependencies explicit? Are acceptance criteria verifiable? Is the scope atomic enough for the developer loop?
3. **Design critic** — for user-facing initiatives: is the experience considered? For non-UI: skip.
4. **DX critic** — does this make the project easier or harder to work on? Are migrations / deprecations handled?

## Decision rules

- **Mechanical** (auto-resolve): missing acceptance criteria, ambiguous scope, undeclared dependency, missing rollback note. The council fills these in and notes the change.
- **Taste** (escalate): which of two valid framings to pick, scope cuts vs deferring, naming, prioritisation. The user decides.

## Process

1. Brain query first.
2. Run critics in order via [`runCouncil()`](./council.ts) — each critic is invoked as an SDK subagent with its own perspective prompt, `permissionMode: 'plan'` (no file modifications), and a `json_schema` `outputFormat` that returns `{ flags, escalations }`.
3. The runner aggregates `flags` (mechanical) for auto-application and de-duplicates `escalations` (taste) by `(critic, question)`.
4. Apply auto-resolutions to the draft based on the returned `flags[].appliedFix` descriptions (the calling architect skill writes them).
5. Order escalations by severity (CEO > Eng > DX > Design by default; adjust per project).
6. Return `{ flags, escalations, totalCostUsd, perCritic, fallbackCritics }` to the calling architect skill.

The council's TypeScript helper lives at [`council.ts`](./council.ts). Default critics + their prompts come from `defaultCritics()`. The SDK's `query` is dependency-injectable via `queryFn` for unit tests.

## Robustness contract (I-23 — landed in S2A of the 2026-05-20 refinement)

The runner survives the failure modes observed in the 2026-05-20 batch where
councils running ≥13k-char drafts at a 30-turn budget returned `result`
messages with no `structured_output`. Specifically:

- **`maxTurns` default is 60** (was 5) — large drafts need room.
- **`maxDraftChars` default is 50 000** — drafts longer than this are
  truncated for the critic (the call site still holds the full draft).
  Pass a custom `maxDraftChars` if a critic must see a tighter slice.
- **Empty `structured_output` ⇒ retry once** with a tighter `messageFormat`
  that asks the critic to repeat its verdict as a fenced ```json block; the
  runner parses the first such block out of the assistant text.
- **Second failure ⇒ partial result + fallback event.** The runner emits a
  `council.fallback-required` event via the `onEvent` callback, records the
  critic in `fallbackCritics`, and returns a `CriticVerdict` of
  `{ flags: [], escalations: [] }` for that critic. The runner does NOT
  throw — the calling architect can decide whether to surface the fallback
  to the operator (e.g. as an inline escalation in PLAN.md asking the
  operator to manually critique the slice).

When a fallback is required, the architect skill should:

1. Read the raw text from the `council.fallback-required` event.
2. Add it as a verbatim block to PLAN.md under a "Council fallback" heading
   so the operator sees what the critic was trying to say.
3. Continue with the remaining critics — one fallback should not abort the
   whole chain.

## Constraints

- **Don't ask the user about anything mechanical.** The point is to free up their attention for the decisions only they can make.
- **Don't invent new requirements.** Critics improve what's there; they don't expand scope. Scope expansion goes back to the user as an escalation.
