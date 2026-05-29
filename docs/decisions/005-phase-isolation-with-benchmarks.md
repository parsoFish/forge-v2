# ADR 005 — Phase isolation with per-phase benchmarks

**Status:** Accepted (scaffold)
**Date:** 2026-04-24
**Amended 2026-05-25** — the benchmark harnesses under `benchmarks/` were removed; phase quality is now judged on real merged cycles (see CLAUDE.md). The phase-isolation decision itself stands; only the benchmark realization was retired.

## Context

User principle 3: *"Each phase should have clear success signals that allow agents to work on a phase and prove their changes are making a meaningful impact."* Without this, every change is judged by running a full cycle — slow, expensive, and noisy.

V1 had a Tier 1 / Tier 2 eval harness but it was scoped to overall agent behaviour rather than per-phase improvement. Phase-isolated benchmarks are needed so a session focused on (say) the Architect can prove the Architect got better without running a Developer Loop.

## Decision

**Every phase has a benchmark suite at `benchmarks/<phase>/`** that exposes:

- `<phase>/README.md` — input format, scoring metric, how to add cases.
- `<phase>/score.ts` — runs the benchmark suite end-to-end against the current state of the phase's skill(s) and emits a JSON score.
- `<phase>/<cases>/` — input fixtures + expected outputs (format varies per phase).

`npm run bench:<phase>` runs the suite. CI can run all suites; sessions run only the phase they're working on.

The phase docs in `docs/phases/<phase>.md` each name their benchmark contract. The scaffold ships the harness wired-but-empty; cases are added as each phase is built.

## Consequences

**Positive:**
- Fast feedback per-phase. A change to the Architect skill can be benchmarked in seconds, not minutes.
- Cycle-over-cycle improvement is measurable.
- Reduces the "did this help?" debate to "did the score go up?".

**Negative / accepted trade-offs:**
- Maintaining benchmark cases is real ongoing work. Mitigated by treating reflection-discovered failures as new benchmark cases.
- A phase's benchmark can drift from real-world performance. Mitigated by occasional full-cycle runs.

## Alternatives considered

- **Only end-to-end evals** — slow and noisy; rejected.
- **Manual qualitative judgment** — doesn't scale with autonomy; the system needs to judge itself.
- **A single shared eval harness across phases** — couples phases that should be improvable independently.

## References

- v1's `src/eval/` Tier 1 + Tier 2 harness (Pass B will theme this; the structure inspired this ADR)
- [eval-driven development pattern](https://www.everything-claude-code.com) (general agentic engineering practice)
