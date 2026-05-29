# ADR 020 — The architect runs in the forge UI as an operator-driven, file-checkpointed runner

- **Status:** accepted
- **Date:** 2026-05-29
- **Supersedes / amends:** amends ADR 003 (all agents are skills) and ADR 011 (unattended scheduler); supersedes the architect half of the brain decision theme [`human-interaction-via-own-session`](../../brain/forge-dev/themes/human-interaction-via-own-session.md) and the S2A "out-of-cycle, hand-run architect" position. Builds on the Phase A–C UI work on branch `feat/ui-live-telemetry`.

## Context

The architect is one of forge's three deliberate human-interaction moments. It
has been an **interactive Claude-Code skill** (`skills/architect/SKILL.md`,
`surface: interactive`): the operator runs `/forge-architect` in their own
terminal session, the skill drives an `AskUserQuestion` interview, calls
`runCouncil()`, writes `PLAN.md` + `PLAN.html`, and stops; `forge architect
commit <sid>` then ingests the operator's verdict and promotes manifests to
`_queue/pending/`.

The brain decision theme [`human-interaction-via-own-session`] recorded the
rule that the three human moments must run in the operator's **own** Claude
session as slash commands, *never* as a forge-spawned agent. The reason that
mattered: the trafficGame arc blurred autonomous forge with hand-directed work
because the human moments had no clean surface (hand-loaded "Path-B" architect,
auto-approve verdict). Slash commands made each moment **explicit, in the
operator's context, and impossible to silently auto-satisfy**.

The UI overhaul (Phases A–C) turned the operator UI into a live agent-flow
stage with a comparative, in-app `PLAN.html`. The natural completion is to run
the architect **in that UI** — idea → interview → council → comparative PLAN →
approve → autonomous loop, all in-app, with the architect's tool activity
streaming into the live stage. But there is no headless architect runner, and a
bridge-driven turn cannot drive the interactive skill's `AskUserQuestion`.

## Decision

**Move the architect into the forge UI as a server-side, operator-driven,
file-checkpointed runner**, replacing the terminal `/forge-architect` slash
command and the `forge architect commit` CLI.

1. **It is still an explicit, un-auto-satisfiable human moment.** The property
   the original decision protected was not "the operator's literal CLI session"
   but **explicit + operator-initiated + impossible to silently auto-satisfy**.
   The in-UI architect keeps all three:
   - Forge **never auto-starts** the architect. It runs only on an explicit
     operator "New idea" action in the UI. The scheduler / `runCycle` never
     spawn it — **ADR 011 is preserved**; the architect stays out of the
     auto-claim loop.
   - There is **no auto-approve.** The operator must explicitly approve the PLAN
     gate, resolving every council escalation, before any manifest reaches
     `_queue/pending/`.

2. **Interview = file-based handoff, not SDK tool interception.** The runner
   advances an interview by writing `questions.json` (the reflector's
   `StructuredQuestion[]` shape) and reading `answers.json` — the same pattern
   the reflector already uses for its file-based human moment. The Claude Agent
   SDK's `canUseTool` hook (v0.1.77) is an allow/deny **permission gate**; it
   cannot return the operator's answer as the `AskUserQuestion` tool result, so
   it does not fit. File-handoff is also more forge-native: durable, resumable
   (ADR 012), and file-as-source-of-truth (ADR 007/008).

3. **The runner is a bounded, Ralph-style turn.** Each operator action (start,
   answer, verdict) spawns a fresh architect-runner child (the detached-child
   pattern the bridge already uses for the scheduler daemon). The runner reads
   the session-dir state, advances **one** step via a `status.json` cursor, and
   exits. Operator think-time happens *between* processes — no long-lived
   blocked session. State lives in `<projectRepoPath>/_architect/<sid>/`, so a
   crash mid-flow recovers by re-reading the files (ADR 012).

4. **The runner's prompt is the skill's content, not re-baked TS.** The runner
   composes its prompt from `skills/architect/SKILL.md` (amended with an "in-UI
   / headless surface" file-handoff stanza, mirroring the reflector skill), so
   prompt changes remain content changes — **ADR 003 is preserved in spirit**:
   the architect is still a skill; the runner is its headless host, exactly as
   `loops/ralph/claude-agent.ts` hosts the developer-ralph skill. The LLM call
   sits behind an injectable `queryFn` seam (the `runCouncil` pattern) so every
   turn is unit-testable without a live LLM. `runCouncil()`, `writePlanDoc()`,
   and `renderPlanHtml()` are reused unchanged.

5. **Manifest promotion is shared, not duplicated.** The manifest-promotion path
   (`parseManifest` → `validateManifest` → `writeManifest`) is extracted from
   `architect-commit.ts:doApprove` into a shared `promoteManifests()` helper the
   runner's finalize step reuses.

## Consequences

- **One unified app.** The operator runs the whole forge loop in the UI; the
  architect hex lights up with real tool bursts in the live stage.
- **Autonomy stays unblurred.** No auto-start, no auto-approve, architect out of
  the scheduler — the anti-blurring property the superseded theme protected is
  carried forward by design, not by the slash-command surface.
- **Durable + resumable.** File-checkpointed turns mean a bridge restart or
  crash mid-interview loses nothing; the session dir is the state.
- **Bridge surface grows** (operator-greenlit). New routes are additive and
  namespaced under `/api/architect/` + `/api/plan-verdict`; the only new
  `orchestrator/` module is the runner. The hot path is untouched.
- **Terminal architect retired.** `/forge-architect` and `forge architect
  commit` are removed; `forge architect run <sid>` (single-turn, bridge-spawned)
  replaces `commit`. Callers (CLI help, docs, harness) are updated.

## Alternatives considered

- **SDK `canUseTool` interception of `AskUserQuestion`** (the original handoff
  proposal). Rejected: `canUseTool` only allows/denies a tool; it cannot inject
  the answer as the tool result, and a live blocked session is less durable than
  file-handoff.
- **Live in-process MCP "ask operator" tool** (`createSdkMcpServer`). Viable and
  gives a true live interview, but the bridge would hold a long-lived blocked
  SDK session while the operator thinks, and a crash mid-interview loses live
  state. Rejected in favour of the durable file-handoff turn model.
- **Keep the terminal architect alongside the UI one.** Rejected by the operator
  in favour of a single surface.
- **Keep the architect fully out-of-cycle (status quo).** Rejected: leaves the
  app split between a terminal moment and a UI that can't complete the loop.
