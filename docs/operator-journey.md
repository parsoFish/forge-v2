# The forge operator journey (vision + intent)

> **Status:** operator's canonical vision for the end-to-end journey, 2026-05-30.
> This defines the intent and the **target high-level behaviour forge moves
> towards** — not only the as-built. The video-recorded
> [`scripts/e2e-journey.mjs`](../scripts/e2e-journey.mjs) is its executable
> spec: it walks these exact 13 steps, at a watchable pace, through the
> centralised forge UI (ADR 020 + 021). Where a step is partly aspirational the
> harness still demonstrates the *target*, and this doc names the gap so the
> journey doubles as a roadmap.

The whole journey is centralised on the forge UI. The operator never leaves it.

## The 13 steps

1. **New idea provided.** The operator types an idea on the dashboard.
2. **Architect flow begins with the architect's review of the project** — it
   reads the project + brain and **explores edge cases** before asking anything.
3. **Through that exploration + review + the idea, the architect returns with
   any questions** to be clarified.
4. **The operator answers; the next architect planning stage rolls in those
   answers.**
5. **The processed draft goes to the review council; based on the council's
   output the architect presents the plan options** (the design decisions) shaped
   by that feedback.
6. **On operator feedback, the architect reruns the last step** (re-council /
   re-plan) and re-presents.
7. **On operator approval, the journey moves to the PM.**
8. **The PM plans the features and work items** for the initiative.
9. **The developer loop picks up work items and progresses them, respecting
   dependencies.**
10. **Once all work items are complete, the unifier reviews and loops to clean
    the output.**
11. **The unifier then wraps up by running the demo skill to produce the demo
    page** for operator review, themed to match the forge UI.
12. **The operator reviews the demo; Ralph dev-loops run continuously with
    operator input after each cycle until the operator approves.**
13. **Once the operator approves, the journey moves to the reflect phase.**

## As-built vs target (honest gap)

| Step | As-built today | Gap to the vision |
|---|---|---|
| 1, 3, 4, 7, 8, 9, 13 | Wired — dashboard new-idea, file-handoff interview, plan approve→PM, PM features/WIs, dependency-ordered dev-loop, reflect-on-merge. | — |
| 2 — architect reviews project + explores edge cases | The runner brain-queries + reads the project before drafting. | Surface "exploring / edge cases" as an explicit architect stage (label + bursts), and prompt the architect to enumerate edge cases. |
| 5 — council → plan options from feedback | `runCouncil` runs in the draft turn; its escalations become the PLAN gate's design decisions. | Surface the **council** as its own visible stage between drafting and the plan gate. |
| 6 — plan send-back reruns the last step | Plan gate "Send back" → a revise turn regenerates. | Make the rerun visibly re-run council + re-present, not just regenerate. |
| 10 — unifier reviews + loops to clean | Unifier sub-phase iterates against the gates. | Surface the unifier's clean-up loop distinctly from the per-WI dev-loop. |
| 11 — unifier runs the demo skill → themed demo page | Unifier authors `demo.json`; forge renders the themed DEMO; `demo-capture` skill is optional. | Make the demo-skill run a first-class unifier wrap-up step (always produce the page; capture media when visual). |
| 12 — review loops with dev-loop reruns until approve | Review screen verdict; send-back writes a verdict the reviewer reacts to. | Make send-back on the review screen visibly spawn a dev-loop, re-demo, and re-present — a continuous review↔dev loop gated only by operator approval. |

The harness emulates the **target** for every step (seeding the files/events the
real phases write, or will write) so the recording is a faithful picture of
where forge is going, and the table above is the backlog to close the gap.
