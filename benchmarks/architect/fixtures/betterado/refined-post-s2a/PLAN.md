<!-- verdict: approve -->

# Architect PLAN — terraform-provider-betterado (2026-05-18 session)

## Vision recap

Queue the entire ADO 7.1 createable surface for terraform-provider-betterado.
20 initiatives total; 3 substrate initiatives (01, 03, 04) unblock the
remaining 17.

## Brain context

- [`brain/projects/terraform-provider-betterado/themes/release-substrate-context.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/release-substrate-context.md) — release-pipelines gap analysis.
- [`brain/projects/terraform-provider-betterado/themes/council-constraints.md`](../../../../../../brain/projects/terraform-provider-betterado/themes/council-constraints.md) — binding council constraints shared across all 20 initiatives (project-scope, gate command, fixture rules, additive-and-atomic principle).

## Council transcript

See `council-transcript.md` for the full per-critic blob. Summary: all four
critics agreed on the slicing; one escalation surfaced (below) and was
resolved before queueing.

## Proposed initiatives

| ID | Title | Iter. | Cost ($) | depends_on_initiatives |
|---|---|---|---|---|
| 01 | release_definition test substrate + gates | 48 | 34 | — |
| 03 | task_group test substrate | 44 | 30 | — |
| 04 | test plan core | 48 | 34 | 01, 03 |
| ... | (16 more) | ... | ... | ... |

## Aggregate footprint (informational only — no gate per C19)

Iteration budget total: ~840.
Cost ceiling total: ~$534.
Expected cycle count: 20.
Longest dependency chain: 5 (04 → 05 → 06 → 07 → 08).

## Open escalations

- [ESC-1] Council Eng critic flagged: "Should we ship docs in the substrate
  initiatives or defer to a doc-only follow-up?"
  <!-- review: ship docs inline (FEAT-4 in 01, FEAT-3 in 03) — bench cost is
  trivial and the docs are part of the createable contract -->

- [ESC-2] Council DX critic flagged: "Aggregate footprint is $534. Is that
  acceptable in one queueing decision?"
  Deferred to per-cycle close-out — the operator can split the queue if any
  given week's actuals trend hot. Aggregate is informational only.
