---
stage: S2A (amendment)
date: 2026-05-24
source: anthropics/cwc-workshops/how-we-claude-code
contract_deps: [C12, C19, C26, C27]
amends: [02-architect.md, EXECUTION-PLAN.md (§S2A), skills/architect/SKILL.md]
---

# S2A — cwc-workshops amendments

> **Not a re-scope.** These are two additive refinements to S2A that
> sharpen the *front* (interview) and *back* (HTML render) of the
> architect human moment. The locked S2A surface (PLAN.md + annotation
> parser + `forge architect commit`) is unchanged.

## Source material

[`anthropics/cwc-workshops/how-we-claude-code`](https://github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code) is a
three-phase Anthropic workshop sample:

1. **`phase-1-exploration/PROMPT.MD`** — the operator gives a one-paragraph
   product idea; the agent is told to "interview me in-depth using the
   AskUserQuestion tool about what to build, focusing on pulling out any
   ambiguities to create a spec." This produces a written spec.
2. **`phase-2-planning/PROMPT.MD`** — agent generates **4 divergent visual
   design directions** as HTML files for **side-by-side comparison** before
   any code is written.
3. **`phase-3-verify/`** — a finished React app whose components declare
   `data-verify-*` DOM contracts + a `window.__verify` handle, so an
   agent can confirm runtime behaviour. Belongs to dev-loop / review
   territory (`demo.shape: browser`) — out of scope for S2A.

Two of these phases map onto the architect's existing human moment.
S2A absorbs them; we don't add new stages.

## Amendment 1 — front-of-architect interview step

**Today.** `skills/architect/SKILL.md` step 2 says: *"Listen. Reflect the
user's idea back in your own words and confirm understanding before
proposing structure."* That's the step where the betterado 20-init drop
and the trafficGame scope creep (L9) slip past the architect. The brief
is taken at face value; ambiguities are not surfaced until the council
runs (often after a manifest has been drafted).

**Refinement.** Insert a structured `AskUserQuestion` interview round
between the brain-query step and the council invocation. Bound it so it
can't run forever:

- **Mandate:** architect MUST invoke `AskUserQuestion` **at least once**
  before the council step. Inputs to the interview: the user's brief,
  the brain-query results, the project's roadmap.
- **Cap:** ≤5 interview rounds total (free-form chat between rounds is
  fine; an interview "round" = one `AskUserQuestion` call). The architect
  decides when to stop based on whether ambiguities remain.
- **Bundling:** the questions + chosen answers are captured into PLAN.md
  as a new section `## Operator brief + interview` (frontmatter +
  paragraph + Q/A table). This is greppable, and it's the audit trail of
  *what the operator actually told us* — distinct from "what the council
  decided about it later."
- **Escape valve:** if the user pushes back ("don't keep asking me, just
  draft"), the architect honours it. The mandate is "ask at least once"
  not "ask until satisfied." We trust the operator's signal.

**Why bounded.** This is a human moment that runs out-of-cycle, so
ceremony cost is tolerable — but a 20-round Socratic interrogation is
not. ≤5 with operator override matches how the operator already drives
the architect today, just made *structured* instead of *implicit*.

**Why mandatory at all.** The cwc Phase 1 mechanism only works if the
agent commits to it. The 20-init betterado drop happened because the
architect skipped to manifest-drafting too fast; the SKILL prompt today
doesn't have a hard stop that says *"you may not draft until you've
asked the operator at least one structured question about
ambiguities."* The bench can verify the interview happened (the
`interview-section-present` regex against PLAN.md, sibling to the
existing `brain_consulted` check).

### Files touched by Amendment 1

- `skills/architect/SKILL.md` — add interview step between current
  steps 2 ("Listen") and 3 ("Invoke `architect-llm-council`"). Rename
  step 2 from "Listen" to "Brief + interview". Stub:

  ```
  2. Brief + interview.

     - Restate the operator's brief in your own words (one paragraph).
     - Invoke AskUserQuestion at least once with 1-4 questions targeting
       the highest-leverage ambiguities: scope edge (in/out), success
       signal (when is this done?), prior-art tax (anything already
       attempted?), constraint (any hard no's?).
     - You MAY do up to 5 interview rounds total. STOP earlier if:
       (a) the operator answers "just draft" or similar,
       (b) you have enough to draft a manifest without unresolved
           scope/success-signal/constraint ambiguity,
       (c) the next question would only refine, not unblock.
     - Capture: the brief paraphrase + a Q&A table of every question
       asked and every answer chosen (or "[operator skipped]"). This
       becomes PLAN.md's "Operator brief + interview" section.
  ```

- `orchestrator/architect-plan.ts` — `ArchitectSession` type gains
  `operator_brief: { paraphrase: string; interview: Array<{ question: string; answer: string }> }`.
  `renderPlanDoc` adds an "Operator brief + interview" section right
  after the title / frontmatter and before "Vision recap" — same place
  the cwc Phase 1 spec lives.

- `benchmarks/architect/scoring.ts` (S2B follow-up — NOT this amendment,
  but flagged): a new sub-metric `interview_section_present` (gate or
  small-weight criterion) tests that the section exists with ≥1 Q/A row.
  S2A landing emits the data; S2B's scoring rewrite consumes it.

### Acceptance for Amendment 1

- A real `/forge-architect terraform-provider-betterado` session
  produces a PLAN.md with an "Operator brief + interview" section
  containing ≥1 Q&A row.
- Unit test: `architect-plan.test.ts` covers `renderPlanDoc` with an
  empty interview array (rendered as "[no interview rounds — operator
  drafted directly]") and with multiple rounds (rendered as a table).
- SKILL surface test: a synthetic session where the agent skips the
  interview must be visibly absent in the PLAN.md, providing a
  greppable failure mode for future audits.

## Amendment 2 — PLAN.html sibling artefact

**Today.** S2A emits `PLAN.md` + sibling `council-transcript.md` + a
`manifests/` drawer. PLAN.md is the operator review surface — both human
viewer AND annotation target. That conflates two concerns: rendering
fidelity (humans want diagrams, side-by-side option cards, colour-coded
escalations) vs. parse fidelity (the CLI reads `<!-- review: -->` HTML
comments out of plain markdown).

**Refinement.** Render a sibling `PLAN.html` next to `PLAN.md`. PLAN.md
remains the **annotation target** — operator still writes `<!-- review:
... -->` comments in markdown, and `forge architect commit` parses
markdown not HTML. PLAN.html is the **rich viewer** — operator opens it
in a browser to read.

**Two artefacts, one source of truth.** Both rendered from the same
`ArchitectSession` struct via two pure functions:

- `renderPlanDoc(session) → string` (markdown, already exists)
- `renderPlanHtml(session) → string` (new — emits self-contained HTML)

The HTML output is **zero-dependency**: one file, inline CSS, no JS
unless needed for interactivity (escalation card hover/expand). cwc
Phase 2's mockups are the reference — static HTML, viewport-fit, clear
typography, no `purple-gradient template look`.

**What the HTML renders that markdown can't.**

1. **The forge cycle diagram** (operator's hand-drawn one, formalised as
   inline SVG or mermaid → static SVG at render time): `architect →
   initiative + initiative html page → 3 feats → 9 work items →
   initiative branch → before/after demo+pr → reflect`, with `graphify
   brain` hovering and the three user-touch icons at `architect`, `PR`,
   `reflect`. Renders at the top of PLAN.html as the spatial context for
   *where this initiative sits in the cycle*.

2. **Escalation cards (cwc Phase 2 spirit).** Council escalations today
   are bulleted text: *"Should this plan be sliced into two
   initiatives? [option A] [option B] [keep bundled]"*. PLAN.html
   renders each escalation as a **side-by-side card** showing the
   option's name, the consequence, and the "vote" the council critics
   gave (visible as small chips per critic). This is the smallest cwc
   Phase 2 application that earns its keep — *visual comparison only
   where the operator actually has to compare*.

3. **Aggregate footprint visualised.** A horizontal stacked bar
   (informational only — colour-coded by initiative, no threshold lines
   — keeps the C19 "no gate" promise visible) showing the iteration
   budget split. Numbers also appear as a literal "informational only,
   no gate, no auto-escalation" line beneath, matching the markdown.

4. **Manifest drawers** as `<details>` elements (collapsed by default;
   PLAN.html stays a one-screen overview when first opened, drills in
   on click).

**What the HTML deliberately doesn't do.**

- No live form / no annotation surface. The operator annotates PLAN.md
  in their editor. (HTML-as-annotation-surface was option B; rejected.)
- No JS framework. Single file, inline `<style>` and minimal `<script>`
  if needed.
- No round-tripping. PLAN.html is regenerated on each `revise`; never
  read back as input. (Markdown is the only durable input source.)
- No external assets. No web fonts, no CDN — the operator's browser
  may be offline.

### Files touched by Amendment 2

- `orchestrator/architect-plan.ts` — add `renderPlanHtml(session)`
  (pure function, returns string) and update `writePlanDoc` to also
  write `<sessionDir>/PLAN.html` next to `PLAN.md`. Expose
  `renderPlanHtml` for testing.
- `orchestrator/architect-plan.test.ts` — `renderPlanHtml`
  smoke + golden tests: empty session, single-initiative, multi-initiative
  with escalations, exploration-type initiative (C27).
- `skills/architect/SKILL.md` — step 10 ("Tell the user") prints both
  paths: `PLAN.md (annotation target)` + `PLAN.html (open in browser to
  view)`. The "open with `xdg-open` / `open` / browser" hint is OS-aware
  but optional — operator picks.

### Acceptance for Amendment 2

- A real betterado session emits PLAN.html alongside PLAN.md. Opening
  PLAN.html in a browser shows: the forge cycle diagram, the operator
  brief + interview Q&A, the brain context, the council transcript
  (collapsed), proposed initiatives (collapsed drawers), the aggregate
  footprint bar, the escalation cards.
- `npm run build` produces no new external deps (HTML render uses no
  libraries; we already have access to `node:fs`).
- `tsc --noEmit` clean. `prettier` formats the heredoc-style HTML
  template in `architect-plan.ts` without complaint.
- PLAN.md unchanged in shape — old tests still pass; bench's
  PLAN.md-only path is unaffected.

## What this amendment does NOT change

- **S2B (bench reground).** B1 + B2 fixtures, `benchmarks/_lib/handoff.ts`,
  the new scoring criteria — all unchanged. S2B is the next stage and
  consumes the PLAN.md (not PLAN.html) handoff.
- **C12 (PLAN.md location).** Same: `<projectRepoPath>/_architect/<session-id>/`.
  PLAN.html sits in the same dir.
- **C19 (no budget gates).** Aggregate footprint visualisation is
  informational; the literal "informational only" framing is preserved.
- **C27 (type discriminator).** PLAN.html branches on `session.type`
  the same way `renderPlanDoc` does.
- **`forge architect commit` parser.** Reads PLAN.md only. PLAN.html
  is write-only.

## Why this is two amendments, not two new stages

S2A's locked surface is the **single operator artefact + parse loop**.
The interview step is *upstream* of the artefact (changes what goes
into the renderer); the HTML render is *downstream* of the artefact
(extra view of the same data). Both fit inside one renderer module +
one SKILL.md update. Splitting would force a second contract lock and
two cycles for what is, mechanically, one S2A iteration with two extra
moving parts.

The risk of bundling: if Amendment 2 (HTML render) hits a snag, we don't
want it to block the interview step from landing. Mitigation: ship the
SKILL.md interview-step update FIRST (one PR), then the HTML renderer
SECOND (one PR). Both inside the S2A landing — no new stages.

## Operator decisions captured

This amendment was negotiated on 2026-05-24 in conversation. The three
recommendation paths the operator confirmed:

1. **Interview shape:** `AskUserQuestion`-driven, bounded (≤5 rounds,
   mandatory ≥1).
2. **HTML divergence:** one HTML page rendering THE plan + escalation
   cards. Not literal cwc-Phase-2 "N divergent design HTML files."
3. **Review surface:** keep both — HTML is read-only viewer, PLAN.md is
   annotation target.

These three are now locked for S2A's amended landing. If a real cycle
shows one of them is wrong, capture the learning in the cycle archive
and revise the amendment before the *next* refinement stage starts —
not mid-stage.
