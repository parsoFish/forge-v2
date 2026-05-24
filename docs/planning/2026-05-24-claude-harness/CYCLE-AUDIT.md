# Cycle 7 audit — gate-quality root cause

> Per operator's framing: agents have freedom in HOW; success is the
> gate; the gate must actually prove the AC. So if a WI passes the
> gate without delivering its intent, the **gate is the bug**, not
> the agent's lack of declared files. Audit below traces this from
> the PM's WI-emission step to the unifier's escape-less wedge.

## The chain (cycle 7 evidence)

```
PM emits 6 WIs, all WITHOUT quality_gate_cmd
        │
        ▼  (developer-loop sees no per-WI gate → falls back to default)
default gate = project's `npm test` = `node --test tests/*.test.ts`
        │
        ▼  (at WI-1's iter 0, only tests/baseline.test.ts exists)
baseline.test.ts trivially passes → npm test exits 0
        │
        ▼  (F-26 currently SKIPS the iter-0 quality-gates-pass check,
        │   so the agent is forced to run iter 1 regardless)
agent writes SOME code, npm test still exits 0
        │
        ▼  (gate.pass at iter 1 → WI marked complete, regardless of
        │   whether src/events.ts or any declared output exists)
WI-1 marked complete · $0.84 · 1 iter · quality-gates-pass
        │
        ▼  (loop through WI-2..6, same hollow-gate pattern;
        │   autoCommitWorktreeIfDirty commits anything the agent wrote,
        │   but doesn't enforce what)
dev-loop "6/6 complete" — but src/cli.ts, integration tests,
fixtures, golden file all missing or partial
        │
        ▼
unifier runs, reads the WI specs + git log, correctly diagnoses:
"src/cli.ts is missing (WI-2 was autocommited but cli.ts isn't there),
 integration tests are missing (WI-3), fixture files are missing
 (WI-3, WI-6). The initiative partially landed."
        │
        ▼  (unifier has no send-back mechanism, no escape;
        │   keeps iterating until iteration-budget exhausted)
unifier: terminal failure, dev-loop-unifier-demo-failed
cycle: terminal failure
```

## What's broken

**Not** the agent. The agent was given a gate; the agent made it
pass. That's what gates are for.

**Not** the validator's flexibility. Forcing `creates:` upfront
(which I removed per your "overly restrictive" feedback) doesn't
fix this — even a WI with a perfect `creates:` list still has a
hollow gate that passes trivially.

**The gate itself.** When `quality_gate_cmd` is unset, the WI
inherits `npm test` which exercises the project's existing test set
— **not the WI's ACs**. A clean tree where the AC implementation
hasn't been written yet should make the gate **fail** (e.g.,
"tests/events.test.ts: 0 tests run" or "events.test.ts: import
'../src/events.ts' resolves but `readEvents` is undefined").

The gate IS the proof. If the gate passes before the agent does
anything, the gate isn't proving anything.

## The fix — two layers, both deterministic

### Layer 1: validator (catches PM-forgets-to-write-gate)

`work-item.ts:validateWorkItem` should **require** `quality_gate_cmd`
on every WI. Currently optional (line 220: `if (w.quality_gate_cmd
!== undefined) { ... }`). Make it mandatory.

PM emits a WI without a gate → validator rejects → PM has to either
write a gate or admit the WI is malformed.

### Layer 2: gate must fail on clean tree (catches PM-writes-loose-gate)

`loops/ralph/runner.ts` currently SKIPS the `quality-gates-pass`
check on iteration 0 (per F-26). The original concern was "no-op
WIs whose gate passes immediately" — but in the operator's framing,
every WI has an AC and the gate's job is to prove it; if the gate
passes BEFORE the agent works, the AC is either already met (WI is
spurious) or the gate is loose.

Either way, fail the WI early with a clear classification:
`gate-too-loose: passed before agent invocation`. Don't burn iters
on a hollow gate. The PM has to sharpen.

This is the exact mechanism the unifier was performing manually
(via "the initiative partially landed" diagnosis) — lifted to a
deterministic per-WI check.

### What this does NOT add

- No `creates:` requirement (preserves agentic flexibility).
- No `files_in_scope` enforcement (agent can edit any file).
- No upfront file-path declarations (the WI's contract is the AC +
  the gate's exit code, not a file manifest).
- No unifier role expansion (it stays "implement the demo", not
  "arbiter of completeness").

## Why this matches your guidance

1. **"Agents should be given the freedom to figure out how"** —
   yes; the agent picks any files, any structure, just has to make
   the (sharp) gate pass.
2. **"By this same mechanism the unifier agent is able to identify
   work was not done"** — the unifier checks "does the initiative
   manifest"; this lifts the equivalent check to per-WI ("does
   the AC manifest, per the gate's exit code").
3. **"Something is wrong with the work items we are generating
   themselves"** — yes; PM emits WIs with loose gates. Both layers
   above push that bug back to PM where it belongs.
4. **"Potentially this is a problem with how success is gated on
   each work item"** — directly addressed.

## Implementation order

1. Add the iter-0 gate-must-fail check (`loops/ralph/runner.ts`).
2. Make `quality_gate_cmd` required in `validateWorkItem`
   (`orchestrator/work-item.ts`).
3. Update `skills/project-manager/SKILL.md` with explicit guidance:
   "your gate MUST exercise the AC and MUST fail on a clean tree
   before the agent's first iteration."
4. Re-run cycle 1.
5. If still failing for a new reason, audit again before another
   round.

I'll proceed with this unless you push back on any of the four
steps. The cleanest change touches three files; no schema break
beyond the `quality_gate_cmd` going from optional → required.
