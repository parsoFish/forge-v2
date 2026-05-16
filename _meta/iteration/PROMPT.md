# Loop mission (Ralph pattern — reused, not hand-rolled)

You are an autonomous iteration on the **forge repo** (an external dev
loop — NOT forge's orchestrator running forge; respect
`forge-never-self-modifies`).

## Algorithm (one iteration)

1. `node --experimental-strip-types _meta/iteration/closure-check.ts --tier=fast`
2. If it exits 0 → run `--tier=full`; if that exits 0 → **STOP, done.**
3. Else: read `_meta/iteration/fix_plan.md`; take the **first open `[ ]`
   unit in dependency order** whose prerequisites are done.
4. Implement it (TDD where code; deletion-first per the simplification
   mandate). `tsc` + `npm test` MUST be green before committing.
5. Conventional commit, one concern. Tick the unit `[x]` in fix_plan;
   append a one-line note to `AGENT.md`.
6. Re-run the relevant closure rows. Next iteration.

## Stop conditions (Ralph)

- `closure-check --tier=full` exit 0 → success, stop.
- iteration budget / cost budget exceeded → stop, escalate to human.
- wedged: 3 iterations with no fix_plan progress → mark the unit
  `blocked`, surface it, continue other ready units; if all remaining
  are blocked → stop, escalate (a legitimate human moment).

## Hard rules

- Remove wherever possible (simplification overrides "keep").
- No feature flags / fallback / "backwards compat" paths.
- No hand-rolled loop engine; the gate is `closure-check.ts`.
- Architect stays a human moment (`/forge-architect`); never wire it
  into `runCycle`.
- Acceptance lives in `_meta/iteration/PLAN.md` §source-of-truth and
  `coverage-matrix.md`. The loop cannot self-declare done.
