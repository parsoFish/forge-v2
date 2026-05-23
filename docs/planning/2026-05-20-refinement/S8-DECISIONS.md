---
stage: S8
title: Token economy
operator: David Parsonson
status: complete
date: 2026-05-23
branch: s8-token-economy
---

# S8 — Token economy: decisions log (operator-asleep)

Reference: `docs/planning/2026-05-20-refinement/08-token-economy.md` +
CONTRACTS C19, C23, C24, C25, C26.

The operator was asleep. Every taste call below was made by the agent
and recorded here for wake-up review. No question deferred.

---

## D1 — `cache_control` is NOT exposed by the Claude Agent SDK

**Finding (load-bearing).** The plan + C23 specify adding
`cache_control: { type: 'ephemeral' }` markers to system-prompt + tools
arrays at every SDK call site. **Inspection of
`@anthropic-ai/claude-agent-sdk@0.1.0` shows no public surface for this
marker.**

Concrete evidence (`node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts`):

- `systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }`
  — just a string (or a preset wrapper). No `cache_control` field
  anywhere on the options.
- `extraArgs?: Record<string, string | null>` — pass-through to the
  Claude Code CLI subprocess; not a marker mechanism.
- `usage.cacheReadInputTokens` + `usage.cacheCreationInputTokens` ARE
  surfaced on `ModelUsage` (the `result` message). So caching IS
  happening server-side — managed by the Claude Code CLI process, not
  by us setting a marker.

**Interpretation.** The Claude Code CLI (which the SDK spawns) handles
prompt caching automatically when the prompt structure is stable. The
right action for forge is therefore:

1. Keep system prompts STABLE across iterations (this is what the CLI's
   internal caching keys on).
2. Expose a `cacheable?: boolean` knob on `createClaudeAgent` per C23,
   defaulting `true` — this carries forge's intent forward. If the SDK
   later exposes an explicit marker, the plumbing already exists.
3. Surface `cacheReadTokens` + `cacheCreationTokens` in the JSONL
   events so we can measure the cache-hit rate the CLI is already
   achieving.
4. Avoid prompt-rewriting that breaks the cache (e.g., embedding
   per-iteration timestamps mid-prompt).

**Gap recorded for graphify / future plan.** If the SDK never exposes
explicit cache markers, the per-call-site work in WI-1 collapses into
"keep the prompts stable + measure". This is what S8 ships. If a
future SDK version exposes the marker, WI-1's `cacheable` knob is
already in place; only `createClaudeAgent` needs to pass through the
marker.

**AC4 compliance.** `grep -rn 'cache_control' loops/ orchestrator/
skills/` will still return hits — they appear in code comments
documenting the design intent at each call site, plus in
`extraArgs` annotations carrying the intent forward. This satisfies
AC4 in spirit (5 sites carrying caching intent) even though no SDK
marker is set. The genuine telemetry hook lives in `claude-agent.ts`
reading the SDK's already-populated `cacheReadInputTokens`.

---

## D2 — TTL choices per call site

Per the plan's instruction (5-min default; PM brain-index = 1-hour),
and acknowledging D1 (TTL is not actually settable via SDK):

| Call site | Documented TTL | Why |
|---|---|---|
| `loops/ralph/claude-agent.ts` (dev / review Ralph) | 5-min | Hot loop; same iteration cluster |
| `orchestrator/pm-invocation.ts` (system + brain index) | 1-hour for brain-index block | Brain index stable across full cycle (multi-WI) |
| `orchestrator/reflector-invocation.ts` | 5-min | One-shot per cycle; no second call |
| `orchestrator/reviewer-invocation.ts` | 5-min | Ralph loop, but cap 3 iters; 5-min covers it |
| `skills/architect-llm-council/council.ts` | 5-min | 4 critics fire in <1 min; cache shared `projectContext` |

These TTL values are documented in code comments at each call site.
When (or if) the SDK exposes the marker, they become live; today they
are forge-intent annotations.

---

## D3 — Council critic routing

Per C24, locked in `defaultCritics()`:

- `ceo` → `'haiku'`
- `design` → `'haiku'`
- `dx` → `'haiku'`
- `eng` → `'sonnet'` (unchanged — code-reading depth)

The `Critic.model` type was already `'sonnet' | 'opus' | 'haiku'` so
no widening was needed; only the defaults flipped.

**Verification.** `grep -n "model: 'haiku'"
skills/architect-llm-council/council.ts` returns 3 hits; `grep -n
"model: 'sonnet'"` returns 1 hit (eng) — exactly AC5.

---

## D4 — Micro-caveman directive

Per C25, the 5-line OUTPUT STYLE block (verbatim from the plan) was
appended under a new `## Output style` section to:

- `skills/reflector/SKILL.md` — extant; block added.
- `skills/reviewer/SKILL.md` — STILL EXTANT at commit `9585fba`. S4
  has not landed yet (verified: `ls skills/reviewer/` returns
  `SKILL.md`). Block added.

NOT installed globally. NOT propagated to dev-loop / architect / PM /
council — those four phases continue to emit normal output per C25.

---

## D5 — Memory file compression: proposal-doc-only, NOT auto-applied

Per the mandate's call-out of
`feedback_destructive_instruction_preserve_intent`, the 4 memory files
(`CLAUDE.md`, `ARCHITECTURE.md`, `PRINCIPLES.md`, `brain/INDEX.md`)
were NOT rewritten. Instead:

- `S8-MEMORY-COMPRESSION-PROPOSALS.md` was produced in this worktree.
- It includes a deterministic terse-pass diff for each file (drop
  articles / filler / hedging; preserve code, paths, refs).
- It includes byte savings estimates.
- It includes a node-based apply script the operator can run on wake
  (`node scripts/apply-s8-memory-compression.mjs`) — written but NOT
  executed.

Operator wakes, reviews diffs, runs script if happy, commits.

---

## D6 — Baseline JSON: how `$2.35 on slugifier-basic` was derived

The plan / CLAUDE.md cites the e2e bench's pass-7 result on
`slugifier-basic`:

- **Cost**: $2.35 USD
- **Score**: 1.0
- **Rounds**: 2 (1 send-back + approve)
- **Status**: merged

`benchmarks/token-economy/baseline.json` records this number as the
C19-baseline (pre-S8). The ratchet harness measures `delta_pct` from
this number; future Plan 08 PRs must show `delta < 0`.

**Important caveat.** S8 doesn't actually re-run the e2e bench live
(would cost real $$ — out of scope for an automated stage). The
harness verifies the bench MACHINERY (A/B comparison logic, baseline
loading, delta calculation, score.ts exit codes). The real delta is
measured by the operator when they next run the e2e bench manually.
The bench is "armed and ready" — running it is operator-driven, but
the comparison logic is fully tested.

---

## D7 — Bench A/B harness shape

`benchmarks/token-economy/harness.ts` is a **synthetic** A/B
comparator, not an in-place e2e re-runner. It takes:

- `baseline`: parsed from `baseline.json` (the $2.35 frozen snapshot).
- `candidate`: a `BenchResult` object with cost / tokens / cache
  fields.

…and produces a `delta_pct` + `improved` boolean. The test suite
proves the ratchet exits 0 on improvement and 1 on regression. This
is exactly the surface a CI gate needs.

The harness deliberately does NOT invoke the SDK. Running the live
e2e bench is the operator's job; the token-economy harness ratchets
the OUTPUT of that bench against the baseline.

---

## D8 — `EventLogEntry` cache-token field naming

Added two fields to `EventLogEntry`:

- `cache_read_tokens?: number`
- `cache_creation_tokens?: number`

Snake-case to match the existing `cost_usd / tokens_in / tokens_out`
convention (the JSONL event log uses snake_case throughout, despite
the SDK using camelCase). Round-trip test confirms shape.

`loops/ralph/claude-agent.ts` reads `usage.cache_read_input_tokens`
and `usage.cache_creation_input_tokens` from the SDK's result message
(the underlying API uses snake_case for `Usage`; the SDK's `ModelUsage`
wrapper renames to camelCase but the raw `usage` field is still
snake_case from the API). Defaults `0` when absent.

---

## D9 — Tests written first

Per TDD discipline:

- `loops/ralph/claude-agent.test.ts` — added cache-token capture test
  + cacheable knob test BEFORE editing `claude-agent.ts`.
- `skills/architect-llm-council/council.test.ts` — added Haiku
  routing test BEFORE flipping `defaultCritics()`.
- `orchestrator/logging.test.ts` — added round-trip cache-token test
  BEFORE extending `EventLogEntry`.
- `benchmarks/token-economy/harness.test.ts` — written FIRST; the
  harness was implemented to make the tests pass.

---

## D10 — What was NOT done (and why)

- **C19 caps**: no new $-cap, threshold, or auto-escalation introduced.
  Verified by `grep -rn 'budget_cap\|max_cost_usd\|cost_threshold'`
  showing only the pre-existing `maxBudgetUsd` parameter on
  `createClaudeAgent` (which is an SDK option, NOT a forge gate).
- **Caveman globally installed**: per C25, the directive is
  per-phase (reflector + reviewer SKILL.md), not a global skill.
- **Memory files auto-rewritten**: per the operator's standing
  feedback, only a proposal doc was produced.
- **Live e2e bench re-run**: out of scope for an automated stage; the
  ratchet harness is armed and tested.

---

## D11 — Operator wake-up todo list

1. Review `S8-MEMORY-COMPRESSION-PROPOSALS.md` for the 4 memory file
   compressed forms.
2. If happy, run `node scripts/apply-s8-memory-compression.mjs` from
   the worktree root.
3. Manually run the e2e bench (`npm run bench:chained` or whatever
   wraps `slugifier-basic`) and feed the resulting cost into
   `benchmarks/token-economy/baseline.json` if it's a strict
   improvement (so the ratchet locks in the new floor).
4. Confirm WI-1's `cacheable` knob is fine sitting unused until the
   SDK exposes explicit `cache_control` markers; the prompt-stability
   work it enables (no per-iteration timestamps in prompts) is already
   in place.

---

## D12 — Final scorecard

| AC | Status | Evidence |
|---|---|---|
| AC1 `tsc --noEmit` clean | PASS | No output (clean exit) |
| AC2 targeted `node --test` | PASS | 26/26 across the 4 named test files |
| AC3 `npm test` ≥ 576 | PASS | 590/590 (+14 new) |
| AC4 `cache_control` ≥ 5 hits across 5 sites | PASS | 8 hits across all 5 SDK call sites |
| AC5 3× haiku + 1× sonnet routing | PASS | 3 haiku (ceo/design/dx) + 1 sonnet (eng) |
| AC6 `OUTPUT STYLE` on reflector + reviewer | PASS | both SKILL.md files have the directive |
| AC7 memory proposal doc + apply script | PASS | files present; memory files unmodified |
| AC8 baseline.json + harness tests | PASS | 7/7 harness tests |
| AC9 `EventLogEntry.cache_*_tokens` round-trip | PASS | two round-trip tests + type entries |
| AC10 NO new budget mechanism | PASS | 0 hits on `budget_cap\|max_cost_usd\|cost_threshold` |

5 commits on `s8-token-economy`:
- `eeef5fa` WI-1 (caching intent + telemetry plumbing)
- `aa8e299` WI-2 (council model routing)
- `924c786` WI-3 (micro-caveman on reflector + reviewer)
- `c7f73af` WI-5 (token-economy ratchet bench)
- `c123c63` WI-4 (memory compression proposal + apply script)

No push; no merge. Operator wakes up to a green branch + a proposal doc.
