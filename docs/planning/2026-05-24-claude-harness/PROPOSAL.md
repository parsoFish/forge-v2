# Claude-harness — proposal

> Operator's ask (2026-05-24):
> > Come up with your own project to onboard to forge to use as the
> > harness. This project could ultimately be your longstanding
> > harness and a project that you can act as the sole operator on
> > (completely autonomous). That way you don't muddy any of my actual
> > projects but can build out features you want to and actually
> > validate the results against your own intent.

## What I'm proposing — `claude-trail`

A small TypeScript CLI: `claude-trail <initiative_id>` walks forge's
on-disk artefacts (`brain/`, `_logs/<cycleId>/events.jsonl`, the
project worktree's `git log`) and produces a **single markdown
"trail" doc** summarising everything related to that initiative —
themes consulted, decisions ratified, events emitted, costs incurred,
commits landed, PRs opened.

### Why this is the right shape for an autonomous harness

| Property                                  | How `claude-trail` delivers it |
|-------------------------------------------|--------------------------------|
| **Small enough for one cycle**            | 3 features, 6-9 WIs, single TS package. A full forge cycle should converge in ≤30 min. |
| **Binary acceptance criteria**            | Output is a markdown doc with named sections; tests compare against frozen golden files. No taste-driven judgement. |
| **Self-contained inputs**                 | brain/ + `_logs/` + git history. No external APIs to mock or rate-limit. |
| **Useful to me**                          | I actually want this. Right now I debug forge cycles by reading 4 different files; the trail consolidates them. |
| **Forces the brain phase to matter**      | brain/ is the durable knowledge base; if `claude-trail` can't surface theme references for an initiative, the brain isn't doing its job. |
| **Naturally grows**                       | Each cycle adds one dimension (cost, deps, related themes, PR diff stats, …). New WIs forever without scope creep. |
| **Distinct from operator projects**       | Lives at `projects/claude-harness/` with its own git history; never touches trafficGame / terraform-provider-betterado / etc. |

### Why not the alternatives

- **trafficGame** — taste-driven outputs ("is this fun?"). Bad signal
  for whether forge improved.
- **terraform-provider-betterado** — exactly the binary kind of project
  we want eventually, but it's the operator's. We agreed it gets the
  next dedicated batch *after* we've proven the loop on something
  smaller.
- A fresh greenfield project unrelated to forge (e.g. a notes CLI) —
  no feedback loop into forge itself; nothing pulls forge's quality up.
- Patching forge directly — that's what the regular dev work is. The
  harness needs a project at arm's length so the cycle exercise is
  realistic.

## How a cycle actually starts — architect interview, NOT pre-baked brief

> Operator's correction (2026-05-24, post-PROPOSAL v1): "make sure
> your planned harness project goes through this intended journey ...
> input at the start of the journey [is] a seed. It should be ... a
> fairly minimal idea that is then put through the architect phase
> with questions asked of the operator as the architect explores and
> surfaces edge cases, ambiguity, etc that the operator then provides
> clarity for."

The MINIMUM viable input I (claude, acting as operator) give the
architect is **one sentence**:

> "I want a small CLI that consolidates everything forge knows about
> a given initiative — its brain themes, its events, its commits, its
> cost — into one markdown trail doc."

That seed goes to `forge architect claude-harness`. The architect
phase then runs its interview — surfacing ambiguity, edge cases,
scope cuts, naming, package layout, what counts as "everything",
what off-the-shelf libraries it might lean on, what the test fixture
should look like, etc. I answer **only what the architect actually
asks**. The output of cycle 1's architect phase is a real PLAN.md
the operator (me) ratifies — it is not a thing I wrote up front.

Concretely, the cycle-1 seed brief is at
[`docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md`](./CYCLE-1-SEED.md)
(to be filed in the next commit) and is exactly one paragraph long.

The three-cycle direction below is **my anticipation of where the
architect/PM will land**, not a prescription. If the architect's
interview pushes us somewhere different (e.g. "trail" turns out to
need a completely different decomposition), we follow that. Anything
I pre-write here is a hypothesis, not a contract — the contract is
the PLAN.md the architect produces and I approve at the
ready-for-review verdict.

## Three-cycle direction (hypothesis, subject to architect's interview)

I'd run these myself (autonomous: I answer the architect's
interview questions, I'm the verdict operator at ready-for-review)
so the operator only sees the recordings + the verdicts I chose, not
the active piloting.

### Cycle 1 — `INIT-2026-05-25-claude-trail-scaffold` (anticipated)

Seed → architect interview → likely scope:

- Package scaffold (`package.json`, `tsconfig.json`, `src/cli.ts` entry
  point, `npm test` runner).
- Reads a frozen `_logs/<cycleId>/events.jsonl` fixture and rolls up
  phase events into a markdown section.
- Reads a frozen `brain/` fixture, finds the themes whose
  `applies_to_initiatives:` frontmatter mentions the target initiative,
  lists them.

**Likely acceptance shape** (architect will set the real bar):
`claude-trail INIT-FIXTURE-1` against the bundled fixture matches
`tests/fixtures/INIT-FIXTURE-1.trail.golden.md`.

### Cycle 2 — `INIT-2026-05-26-claude-trail-cost-rollup` (anticipated)

Likely adds: per-phase cost section, git-log section, PR section
reading `_pr-metadata.json`.

### Cycle 3 — `INIT-2026-05-27-claude-trail-cross-cycle` (anticipated)

Likely adds: `--since <cycle_id>` to include preceding cycles
(retry / send-back rounds), failure-mode summary, top-of-doc summary
table.

## Project layout

```
projects/claude-harness/
├── README.md             — what this is + how to run a cycle on it
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts            — entry point: parses args, dispatches
│   ├── trail.ts          — composes the markdown
│   ├── events.ts         — events.jsonl reader + per-phase rollup
│   ├── brain.ts          — brain theme lookup
│   ├── git.ts            — git log + diff stat (FEAT-2 cycle 2)
│   └── pr.ts             — _pr-metadata.json reader (FEAT-3 cycle 2)
└── tests/
    ├── fixtures/         — frozen brain/ + _logs/ slices
    │   ├── brain/
    │   ├── _logs/<cycleId>/
    │   └── INIT-FIXTURE-1.trail.golden.md
    └── trail.test.ts     — `claude-trail FIXTURE` vs golden
```

It's a single npm package, no monorepo, no extra moving parts. The
test fixtures are checked in (no real operator data leaks).

## What I'm asking the operator to ratify

1. **Direction**: agree this is the right shape for a harness project
   (small, binary, self-contained, useful, grows naturally).
2. **Onboarding mechanic**: I'll bootstrap `projects/claude-harness/`
   with a stub README + `git init` (already done in this branch),
   write a **one-paragraph seed** at
   `docs/planning/2026-05-24-claude-harness/CYCLE-1-SEED.md`, and
   then run `forge architect claude-harness` against it. The
   architect's interview is what produces the actual brief; I answer
   ambiguity questions in real time as they're asked. The first
   cycle's PLAN.md is the architect's output, NOT anything I drafted
   in advance.
3. **Autonomy**: the operator only sees the recordings + the verdicts
   I chose. I won't escalate unless something breaks the harness
   itself (e.g. forge crashes mid-cycle) or the architect surfaces a
   policy question I'm not authorised to answer (e.g. licence choice,
   public/private repo).
4. **Sequencing**: ship 2–3 `claude-trail` cycles before pointing the
   harness at `terraform-provider-betterado`. The forge improvements
   from those cycles should land before we attempt the harder project.

## Open questions

- **Project repo**: standalone repo under `projects/`, or a thin
  subtree inside `forge/`? Standalone is cleaner (gitignored from
  forge per `.gitignore: projects/*`); the trade-off is no PR-on-merge
  flow until I publish it somewhere. Recommend: standalone, with a
  remote when/if it earns one.
- **Bench fixture refresh**: each cycle's golden file should be
  re-generatable when intentional behaviour changes; I'll add a
  `npm run update-goldens` script in cycle 1.
- **Operator's existing review queue**: the harness cycles will land
  in the same `ready-for-review/` dir; I'll prefix initiative IDs with
  `INIT-...-claude-trail-...` so they're trivially filterable.

## What's already shipped vs. left

| Item | State |
|---|---|
| Proposal doc (this file) | ✅ this commit |
| `projects/claude-harness/` skeleton (README + git init) | ✅ this commit (next step in the same PR) |
| `docs/planning/2026-05-24-claude-harness/CYCLE-1-BRIEF.md` | ⏳ next commit, once operator ratifies direction |
| `forge enqueue` for cycle 1 | ⏳ after CYCLE-1-BRIEF.md lands |
| First cycle running end-to-end | ⏳ depends on the above |

Tagging this in `MEMORY.md` so future-me can pick it up if a session
break interrupts.
