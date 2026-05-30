# ADR 023 — The forge UI is the sole operator interaction surface

- **Status:** accepted
- **Date:** 2026-05-30
- **Supersedes / amends:** completes the arc of [ADR 020](./020-architect-in-ui.md)
  (architect in-UI) and [ADR 021](./021-local-review-and-unified-demo.md) (review
  in-UI) by making the UI the *sole* surface; amends the
  [`human-interaction-via-own-session`](../../brain/forge-dev/themes/human-interaction-via-own-session.md)
  theme (the slash-command / PR-comment / CLI verdict ingress is retired).
  Aligns the code with the already-stated vision in
  [`docs/operator-journey.md`](../operator-journey.md) ("the whole journey is
  centralised on the forge UI; the operator never leaves it").

## Context

forge accreted **three parallel operator surfaces** for the same three human
moments (architect, review, reflect):

1. **The forge UI** — dedicated `/architect`, `/review`, `/reflect` screens
   driven by the UI bridge (the working surface as of ADR 020/021 + the
   2026-05-30 reflect screen).
2. **Slash commands** in the operator's own Claude session
   (`/forge-architect`, `/forge-review`, `/forge-reflect`).
3. **CLI subcommands + GitHub PR comments** — `forge send-back`,
   `forge review --approve`, `forge architect commit`, plus a deterministic
   PR-comment poller (`review-router`) and a PR-comment verdict provider
   (`pr-verdict`).

A bottom-up C4 architecture pass (`docs/architecture/c4/`) surfaced the cost:
multiple verdict-ingestion paths, a dual architect entry, and a verdict-provider
abstraction — and a follow-up simplification pass proved much of (2) and (3) was
**dead or duplicate**: `review-router` and `pr-verdict` had zero production
importers, and the `getVerdict` provider was constructed in the scheduler but
never invoked (the reviewer phase opens the PR and stops; send-back re-enters via
a requeue, not a verdict poll).

The operator's direction: **the UI becomes the sole interaction point.** This
does **not** change two things — managed projects are still backed by remote git
repos, and the UI still invokes skills behind the scenes wherever relevant — but
it makes the *interaction surface* singular.

## Decision

**1. The forge UI (via the UI bridge) is the only operator interaction surface.**
Every human moment is a UI screen; the bridge writes the handoff files the phases
already consume (`answers.json`, `verdict-response.md`, `user-feedback.md`). The
terminal/slash-commands/PR-comments are not operator input surfaces.

**2. The load-bearing invariant is preserved, the mechanism is not.** The
`human-interaction-via-own-session` theme's load-bearing property — each moment is
**explicit, operator-initiated, and impossible to silently auto-satisfy** (no
auto-approve, no bench simulator in production) — holds on the UI surface and is in
fact *easier* to guarantee: a single write-path satisfies each gate, so the
property is asserted once instead of audited across N writers. Only the
slash-command/PR-comment *mechanism* is retired.

**3. Retired in this pass (verified dead — zero production importers):**
- `cli/review-router.ts` — the PR-comment poller (cursor file, C16a decision
  table, four `gh api` shell-outs per poll).
- `orchestrator/pr-verdict.ts` — the PR-comment `GetVerdict` provider.
- The `getVerdict` / `GetVerdict` / `VerdictContext` verdict-provider seam:
  `makeFileVerdict` (a never-invoked poll loop) + `renderVerdictPrompt`, the
  `CycleInput.getVerdict` field, and its scheduler construction. `file-verdict.ts`
  is now just the verdict-file path resolver + parser the UI bridge writes for.
- `.claude/commands/forge-review.md` — documented a path that no longer existed
  (it referenced the now-deleted router and a wrong file location).

**4. Sequenced for follow-up (not done in this pass — see the simplification
plan):** retiring the remaining live-but-duplicate CLI/slash paths
(`forge send-back`, `forge review --approve`, `forge architect commit`,
`/forge-architect`, `/forge-reflect`, `forge-reflect-cli`) once the UI has full
parity (e.g. the bridge must auto-rerun the reflector); removing `gh-shim` (all
managed projects have remotes); the UI-bridge tail/scan efficiency fixes; and the
deeper **HumanMoment** generalization (one descriptor + endpoint pair + one
`<HumanMomentScreen>` + per-kind renderer slots) that collapses the three
parallel screen/handler/codec stacks into one.

> **Update 2026-05-30 (follow-up pass — parity confirmed):** the parity-covered
> §4 fallbacks are now retired. The bridge tail/scan efficiency fix and the
> reflect auto-rerun parity landed first; then, with parity verified:
> - **reflect:** deleted `/forge-reflect` (`.claude/commands/forge-reflect.md`) +
>   `orchestrator/forge-reflect-cli.ts` (the slash-render module). The `/reflect`
>   screen renders the questions and the bridge writes `user-feedback.md` +
>   auto-reruns the reflector. `orchestrator/forge-reflect-rerun.ts` **stays** —
>   the bridge calls it.
> - **send-back:** deleted `forge send-back` (`cli/forge-send-back.ts`) + its
>   `cli.ts` dispatch. The bridge's `POST /api/verdict` send-back is a strict
>   superset of `runSendBack` (validates ≥1 AC, writes the same
>   `verdict-response.md` atomically, **plus** manifest locking); both re-enter
>   via the reviewer consuming the verdict file.
> Still deferred: `forge review --approve` (load-bearing — `verify-cycle.mjs`
> auto-approves through it), the architect-canonical decision (`/forge-architect`
> + out-of-cycle skill), `gh-shim` removal, and the HumanMoment generalization.

## Consequences

- **One surface to reason about + secure.** The "impossible to auto-satisfy"
  invariant is enforced at one write-path per moment.
- **~840 lines of dead/duplicate verdict machinery removed** with the build +
  480-test suite green; the verdict-provider abstraction collapses to "a file the
  UI bridge wrote."
- **No behavior change** from this pass: the deleted code had no production
  caller; the send-back loop already works via requeue (`resume_from: unifier`).
- **The PR is still the merge boundary** (closure confirms a real GitHub merge),
  and projects remain remote-git-backed — only the operator's *input* surface
  narrows to the UI.
- **Follow-up carries risk** the dead-code removal did not: retiring the live CLI
  fallbacks needs UI parity first, and `gh-shim` removal touches the
  invariant-critical `pr.ts`. Those are staged, not bundled here.

## Alternatives considered

- **Keep the slash commands as a fallback.** Rejected: forge's ethos is no
  parallel fallback paths (CLAUDE.md "Never do"); the redundant surfaces were the
  source of the drift (and `forge-review.md` had already gone stale and wrong).
- **Delete the live CLI fallbacks now too.** Deferred: some (reflect auto-rerun)
  have a behavior gap on the UI side; deleting them before parity would strand the
  operator. Sequenced behind a parity check instead.
- **Generalize to HumanMoment in this pass.** Deferred: it is a multi-file
  bridge+UI refactor (its own stage/PR); this pass removed the dead weight first so
  the generalization starts from a smaller surface.
