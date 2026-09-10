/**
 * S1 — onboard an existing project (1.0.md §3, row S1).
 *
 * Operator flow: a code repo already sits on disk with no `.forge/`; the
 * operator brings it under forge and gets to a first approved architect plan.
 * Authored interactively with the operator (H6) on 2026-08-29 against
 * `parsoFish/main` a592b1f3. Green expected at M5.
 *
 * GROUND. `projects/gitweave` is a clone of `parsoFish/GitWeave` (Python tests
 * over a Terraform control repo) with **no `.forge/` directory**. That absence
 * is the starting state, not a fault: Studio already discovers the repo and
 * reports it as `health="attention"` / "no .forge/project.json — onboarding is
 * unfinished". The story never creates `.forge/` by hand — the point is that
 * forge creates it. The flow ends at an approved architect plan, which is a
 * real Agent spawn, so `realSpawn` is true and `budget_usd` is declared: the
 * runner refuses to start without `--approve-spend` (H2).
 *
 * ON THE `data-*` KEYS. Every key and value below was copied from the live DOM
 * of a bridge booted from a lane worktree — none is invented. Some of them sit
 * on nested elements (the project card, the onboard section) rather than on
 * `main[data-page]`; since M1-F the runner judges the page root **and its
 * descendants**, which is what the DOM contract has always said it is.
 * REPOINTED (bead `forge-8vfn.7.4.1`, ruling 444): that doc is now
 * `docs/reference/studio-dom-contract.md` — `docs/forge-ui-dom-and-harness.md`
 * no longer exists. The claim survives the move verbatim in substance
 * (`studio-dom-contract.md:4328`: `resolveExpectations` "reads the page root
 * FIRST and only searches descendants for the keys the root does not answer"),
 * so unlike S9's beat-8 citation this one is repointed rather than retired.
 *
 * AMENDED 2026-08-30 (M1-C-S1b, bead `forge-8vfn.2.18`) — EXPRESSION ONLY.
 * The ten beats are the ones the operator approved on 2026-08-29; not one
 * `act`, `expect` or `say` changed. What changed is that beats 3–10 now carry
 * the `do` blocks §3.1 gained in M1-F, so the story can PERFORM the
 * form-driven flow it always described instead of stopping at the first
 * button. Where a beat's act has no declared `data-field`/`data-action` to
 * name, or its route segment cannot be bound, the beat says so in a comment
 * and stays unexpressed rather than being narrowed to fit — the operator's
 * 2026-08-29 ruling ("author the true flow") applied to the verbs as it was
 * applied to the assertions. `_1.0/stories/S1.md` names every one of those
 * gaps and its owner.
 *
 * AMENDED 2026-09-05 (H6, ruling 170, operator present at the terminal) —
 * FOUR beats, and the story grows from ten to ELEVEN. Every gap the 2026-08-30
 * amendment left open has been closed by the product since, so the beats that
 * stood unexpressed can now perform what they always described: beat 4 opens
 * the brief panel before filling it (the missing press that cost this story
 * three runs at $0.00 — no Agent was ever dispatched); beat 7 hands the demo
 * stage over on the surface it stands on and binds the id the handoff mints;
 * beat 10 starts the Architect inline on the project page and binds that id
 * too; beat 11 walks into the session it named. Beat 3 is RE-RECORDED, not
 * repaired: it pinned `checklist-status: 'absent'` for a contract the product
 * scaffolds at registration.
 *
 * The one structural change is beat 7. It carried two acts — hand the demo
 * stage over, AND come back when the builder has finished — and the runner
 * resolves `expect.route` before the `do` steps, so no single beat can both
 * mint an id and stand on the route that id names. Splitting it keeps an
 * assertion on both acts; folding them would have dropped one in silence.
 * Beats 8–11 are the old 7–10 renumbered. Recorded in
 * `_1.0/gate-manifests/M1-C-S1.amend-1.md`.
 *
 * AMENDED AGAIN 2026-09-05, LATER THE SAME SITTING (operator present) — beat 7
 * only, correcting an error the amendment above introduced and the run caught
 * hours later. Beat 7 bound `<demoSessionId>` from `session-id`, a key the
 * SESSION SHELL'S OWN ROOT carries, so it bound the onboarding session's id
 * and beat 8 reported both ids side by side. `resolveExpectations` answers a
 * key from the page root and never consults the nested elements when it can,
 * so on that surface no key `SessionMinted` carries is reachable and the id
 * cannot be bound there by any beat. Beat 7 now asserts that the handoff
 * happened and minted something, and binds nothing; beat 8 keeps its route and
 * stands red with a product owner. Recorded in `M1-C-S1.amend-2.md`.
 */

/** The gate command GitWeave's own repo answers to — `tests/` is pytest. */
const GATE = 'python -m pytest tests/';

/** GitWeave's own README, first line — the north star is the project's, not the story's. */
const NORTH_STAR =
  'A single control repository that configures and weaves together a GitHub organisation using in-repo modules, overlays and provider-native tooling.';

/** The one instruction the story used to have to drop. Beat 6's re-authoring
 *  recorded it leaving — "no surface on the onboarding path asks for it" — and
 *  named bead `forge-8vfn.7.2.5` as the reason. Ruling 441 closed that bead
 *  (#557), so `[data-field="constraints"]` now exists on the brief form and
 *  travels with the north star and the gate through the generic question-form
 *  affordance. The story supplies it again without inventing a field. */
const UNTOUCHABLE_PATHS = 'Never touch infra/ state or config/orgs/*.yaml.';

/** The first piece of work the operator asks the Architect to plan. */
const IDEA =
  'Add an overlay lint that fails the plan when a repo overlay names a team that no module in the org actually grants, so a broken grant is caught before it reaches GitHub.';

/** This run's ceiling, in dollars — the same figure the ground declares. */
const CEILING = '25';

/**
 * What the operator tells the architect when it interviews. It names a scope
 * and a constraint — an answer, not a restatement of the idea — because the
 * architect asks what to build, and S4 run 4 measured what happens when the
 * reply is a constraint alone: the architect asks again.
 */
const ANSWER =
  'Keep it to the onboarding path only — no changes to the existing scan commands. ' +
  'The quality gate stays `python -m pytest tests/`, and the human-readable output must not change.';

export default {
  id: 'S1',
  ground: { project: 'gitweave', realSpawn: true, budget_usd: 25 },
  docs: { kind: 'tutorial', title: 'Onboard an existing project' },
  beats: [
    {
      act: 'Open Studio on the Projects pillar',
      expect: {
        route: '/projects',
        data: {
          page: 'projects-index',
          'page-ready': 'true',
          'card-id': 'gitweave',
          health: 'attention',
        },
      },
      say: 'The Projects pillar lists every project forge manages. GitWeave is already discovered from disk, but it needs attention: it has no contract yet, so no Flow can be pointed at it.',
    },
    {
      act: 'Click "Onboard a project"',
      expect: {
        route: '/projects/new',
        data: {
          page: 'projects',
          'project-id': 'new',
          'page-ready': 'true',
          section: 'project-onboard',
        },
      },
      say: 'Onboarding asks for the few things a Factory needs before it can build a repo: what to call it, the quality gate that judges its work, and the north star that tells a planner what the project is for.',
    },
    {
      // Fully expressible. Every handle below was verified live by M1-F on
      // this exact form; `proof.story.mjs` beat 5 performs the identical six
      // steps and is green for a project forge has never seen.
      //
      // AMENDED 2026-09-05 (H6, operator present) — `checklist-status`
      // re-recorded `absent` → `present`, and the narration rewritten to match.
      // The beat pinned a world where registering a project leaves its contract
      // absent; the product scaffolds the C4 artifacts at registration and says
      // so in its own copy ("the project was registered and the C4 artifacts
      // were scaffolded"). Measured twice — 2026-09-02 (`_1.0/stories/S1.md`,
      // Finding A) and again 2026-09-04 by probe `m5-b-probe9`. Re-recorded,
      // never edited to pass: `preflight-status: 'hard-fail'` STAYS, because
      // the two together are the finding — a present stub that still hard-fails
      // is exactly what onboarding has to work on. (Its sibling amendment, the
      // one that would have split this six-key set across two beats, is struck:
      // the sibling-key absence was the runner's and PR #411 fixed it.)
      act: 'Fill in the name, the quality gate and the north star — and under Advanced, the repo path — then press "Onboard project →"',
      do: [
        { fill: 'project-name', with: 'gitweave' },
        { fill: 'quality-gate', with: GATE },
        { fill: 'north-star', with: NORTH_STAR },
        { press: 'toggle-onboard-advanced' },
        { fill: 'repo-path', with: 'projects/gitweave' },
        { press: 'onboard-project' },
      ],
      expect: {
        route: '/projects/gitweave',
        data: {
          page: 'projects',
          'project-id': 'gitweave',
          'page-ready': 'true',
          'preflight-status': 'hard-fail',
          'checklist-row': 'contract',
          'checklist-status': 'present',
        },
      },
      say: 'Registering the project lands the operator on its page, where forge immediately measures GitWeave against the project contract and reports the result honestly: a hard fail. Registration scaffolds the contract artifacts forge can write without asking anyone, so the checklist says contract — present, and preflight says hard fail, and both are true at once: a scaffolded contract is a stub, not an answer. The secrets, demo and roadmap stages have nothing at all; only the instructions carry real content, read from the repo\'s own CLAUDE.md. No Flow can be pointed at a project in this state.',
    },
    {
      // FULLY expressible since the `<summary>` gained a handle, and AMENDED
      // 2026-09-05 (H6, operator present) to use it. Both halves of this
      // beat's authoring-time gap are closed: the two brief inputs declare
      // `data-field` now (they were `data-onboard-input` when this was
      // written), and `[data-action="toggle-onboard-brief"]` opens the
      // `<details>` they sit in.
      //
      // The single missing press is what cost this story three runs at $0.00.
      // The 2026-09-02 run failed `could not fill [data-field="northStar"] …
      // element is not visible` — the input existed and was the right one; the
      // panel around it was shut. So `forge-8vfn.2.25`, which that run was
      // forecast to exercise, was never reached, and no Agent was ever
      // dispatched. S3's beat 11, authored a day later against the same
      // surface, has always opened the panel first; only a story-authoring
      // session may bring S1 into line with it, and this is that session.
      act: 'Open "Brief the agent", give it the north star and the gate command, and press "Run onboarding agent"',
      //
      // AMENDED (M6-A s3 sitting, operator ruling 490 — 381's delivery switched
      // to A1, so S1 itself exercises the onboarding interview). Ruling 441
      // (#557) made this ONE press start the session at `briefing`, write
      // `questions.json`, and post the brief through the SAME generic
      // `awaits: questions` affordance every other kind publishes; the dispatch
      // happens inside the press, so `onboard-run-status` still reads `running`
      // and this beat's shape is unchanged. `POST /api/studio/onboarding/start`
      // no longer dispatches at all — the bespoke form became a CLIENT of the
      // affordance, which is ADR 043's own direction.
      //
      // TWO ADDITIONS, and each is a claim the product could previously not
      // have kept. `constraints` is the instruction beat 6's re-authoring had
      // to abandon (see its comment, corrected there). `onboard-run-id` is the
      // one field whose MEANING 441 changed: `agent-run.dispatched` moved WITH
      // the dispatch, so the id is published from the moment the run actually
      // begins and a refused brief publishes NONE — before, the status the
      // operator watches could read `running` for an agent that never started,
      // which is the declared-data-fails-open shape on the one surface they
      // have.
      do: [
        { press: 'toggle-onboard-brief' },
        { fill: 'northStar', with: NORTH_STAR },
        { fill: 'gateCommand', with: GATE },
        { fill: 'constraints', with: UNTOUCHABLE_PATHS },
        { press: 'run-onboarding-agent' },
      ],
      expect: {
        route: '/projects/gitweave',
        data: {
          section: 'onboard-with-agent',
          'onboard-run-status': 'running',
          'onboard-run-id': '<onboardRunId>',
          'onboard-session-id': '<sessionId>',
          'onboard-attaching': 'false',
        },
      },
      say: 'The operator does not fill the contract in by hand. An Agent does it, briefed with the three things only the operator knows: what the project is for, the command that tells the truth about whether it works, and what it must not touch. One press asks and answers — the brief travels through the same question form every other session kind publishes, and the run id appears only once an agent is really running.',
    },
    {
      // Fully expressible. The press navigates to
      // `/sessions/onboarding/<sid>?project=gitweave`; the runner matches on
      // pathname, and `<sessionId>` is bound by beat 4's
      // `data-onboard-session-id` — the one place in Studio where a minted
      // session id is rendered before the navigation that consumes it.
      act: 'Follow "View onboarding session"',
      do: [{ press: 'view-onboarding-session' }],
      expect: {
        route: '/sessions/onboarding/<sessionId>',
        data: {
          page: 'session',
          'page-ready': 'true',
          'session-kind': 'onboarding',
          'session-stage': 'contract',
          'buildout-mode': 'checklist',
          'buildout-row-count': '5',
        },
      },
      say: 'The onboarding session opens on the shared session surface. Its live artifact is the same five-stage Contract Buildout the project page shows — contract, instructions, secrets, demo, roadmap — so the operator watches the Agent close the gaps in the same vocabulary the gate will judge.',
    },
    {
      // RE-AUTHORED 2026-09-06 (M5-B s7, bead `forge-8vfn.6.11.25`, T1 ruling
      // 285). This beat used to ANSWER the Agent's questions —
      // `[data-field="session-answer"]` + `[data-action="submit-answers"]` —
      // and it could never pass, on any product, for a reason no bound could
      // fix: THE ONBOARDING KIND NEVER ASKED ANYTHING.
      //
      // CORRECTED (M6-A s3 sitting). That was true when it was written and is
      // FALSE on main today: ruling 441 (#557) gave onboarding a real
      // interview, and `studio/session-kinds.yaml` now declares
      // `{ phase: briefing, step: noop, awaits: questions }` as its one
      // writable row. The finding below is kept because the LESSON is still
      // right — a ten-minute bound was chasing a handle that did not exist, and
      // no bound can fix an absent affordance — but the present tense had to
      // go, and this file is pinned, so a false statement left standing here is
      // one a later author would reason from. Where the interview is exercised
      // now: beat 4, on the project page, through the generic question form
      // (ruling 490's A1). S9 exercises the BARE spine interview separately.
      //
      // A `question-form` affordance is built in exactly one place
      // (`packages/sessions/studio/session-kinds-affordances.ts`) and only for
      // a phase row carrying BOTH `step: 'noop'` AND `awaits: 'questions'`.
      // `studio/session-kinds.yaml`'s onboarding panel declares three rows and
      // no others — `{running, step: agent}`, `{complete, step: terminal}`,
      // `{failed, step: terminal}` — so it publishes no answer field of EITHER
      // name, and the yaml says why in its own words: onboarding "is NOT a
      // turn-loop … a fire-and-forget dispatch with exactly three phase
      // values". Runs 1, 2 and 3 all reported `no element carries that
      // handle`, and run 3's `describeControl` proved it ABSENT rather than
      // slow; that evidence was read as "the agent has not asked yet" and
      // drove `6.11.10`'s ten-minute bound. The bound is right for other
      // beats. For this one the handle was never coming.
      //
      // So the beat now asserts what onboarding DOES: a dispatched agent
      // session that runs to a terminal phase. The declared wait stays — this
      // still stands on a real agent doing real work — and the operator's own
      // knowledge still enters the story at beat 4, where the product actually
      // asks for it (`northStar` + `gateCommand` on the brief form).
      //
      // One thing the old beat carried left the story and, at the time, was
      // not replaced: the untouchable-paths instruction ("never touch infra/
      // state or config/orgs/*.yaml"). No surface on the onboarding path asked
      // for it, so the story could not supply it without inventing a field —
      // named here as the same product question as the interview, bead
      // `forge-8vfn.7.2.5` (M6), rather than papered over.
      //
      // IT IS BACK (M6-A s3 sitting). That bead is closed: the brief form
      // carries `[data-field="constraints"]` and folds it into the brief the
      // affordance posts, so beat 4 supplies the instruction with no invented
      // field. Naming the gap rather than papering over it is what let it be
      // closed and then noticed — which is the argument for naming gaps.
      //
      // Still NOT expressible, and still not invented: walking to a NAMED
      // stage. `StageSelector.tsx` renders one `[data-action="select-stage"]`
      // per stage and distinguishes them by `data-stage`, while `do`'s press
      // verb resolves `[data-action=…]` and takes `.first()`. A generic
      // `select-stage` press would open whichever stage happens to be first
      // and pretend it was `secrets`, so the story does not write one, and
      // this beat no longer claims a stage it cannot reach.
      act: 'Watch the Agent work through the contract until the onboarding session finishes',
      do: [],
      // The declared wait SURVIVES the re-authoring, and it is what makes
      // this beat cost something: `running` is written by POST
      // /api/studio/onboarding/start the moment the dispatch begins
      // (`cli/ui-bridge.ts:3504`), so a beat that only asserted "a session
      // exists" would pass in milliseconds against no work at all. `complete`
      // is written by `writeSessionTerminalPhase(…, 'complete')` when `forge
      // agent dispatch --session-dir` observes the run FINISH
      // (`cli/agent-run.ts:198`, called at `:420`/`:440`) — so waiting for it
      // is waiting for the whole onboarding agent, which is the point.
      //
      // Introduced 2026-09-05 by ruling 220 (bead `forge-8vfn.6.11.10`) for a
      // different reason — one bound, `READY_TIMEOUT_MS = 15_000`, covered a
      // DOM update and an agent's first question alike, and #438 gave a beat
      // its own. That reasoning is superseded (the question never comes) but
      // the bound is not: it now bounds a terminal phase instead.
      //
      // 10 minutes remains a STATED GUESS, not a measurement — no S1 run has
      // ever reached a terminal onboarding phase, so the true figure is only
      // known to be larger than anything observed. It is generous enough to
      // be a real measurement and short enough that a genuine product red
      // does not hold the host for half an hour, and the verdict names which
      // bound gave up, so the next run record cannot confuse "the agent was
      // slow" with "the product is wrong".
      wait: { for: 'agent', upTo: 600_000 },
      expect: {
        route: '/sessions/onboarding/<sessionId>',
        data: {
          page: 'session',
          'page-ready': 'true',
          'session-kind': 'onboarding',
          'session-phase': 'complete',
        },
      },
      say: 'Onboarding is a dispatch, not a conversation. What only a human can say went in at the brief — the north star and the quality gate — and from here the Agent works the contract criteria alone, invoking the Skills built for the purpose, until the session reaches a terminal phase. The clip is the wait, and the wait is the work.',
    },
    {
      // AMENDED 2026-09-05 (H6, operator present) — SPLIT IN TWO, and both
      // halves are now expressible. Both gaps this beat was left open for are
      // closed by bead `forge-8vfn.5.6`: `ContractBuildout.tsx:118` mounts
      // `DemoStageHandoff` on the demo stage's own detail — so the act HAS a
      // declared control on this surface at last — and that component's
      // `SessionMinted` publishes `[data-session-id]` beside
      // `[data-action="view-demo-session"]`, so the id is rendered before the
      // navigation that consumes it. `StageSelector.tsx:46` declares one
      // `select-stage-<id>` per stage, so a beat can finally say WHICH stage
      // it opens instead of taking `.first()` and pretending.
      //
      // The split is forced by the runner, not by taste: `driveBeat` resolves
      // `expect.route` BEFORE the `do` steps, so a beat cannot both mint an id
      // and stand on the route that id names. This beat mints and binds on the
      // page it is standing on — the S4 beat-9 shape — and the next one walks
      // in. The original beat's two acts each keep an assertion; folding them
      // would have dropped one of them silently.
      // AMENDED AGAIN 2026-09-05 (H6, operator present) — the 2026-09-05 run
      // caught an authoring error in this beat's FIRST amendment, made hours
      // earlier in the same sitting, and this is the correction.
      //
      // The first version asked for `session-id: '<demoSessionId>'` alongside
      // `page`, `page-ready` and `session-kind`. It bound the ONBOARDING
      // session's id, and beat 8 reported the two ids side by side:
      // `no real-nav path to /sessions/demo/2026-09-05T02-06-32-703c9252 from
      // /sessions/demo/2026-09-05T02-06-53-05028a45`.
      //
      // The cause is not the answered-together rule, which is what the first
      // reading assumed. `resolveExpectations` (`scripts/stories/beats.mjs`)
      // computes `missing` as the keys the PAGE ROOT does not carry and only
      // then looks at nested records — so a key the root carries is answered
      // by the root and the nested elements are never consulted at all. The
      // session shell puts `data-session-id` on its root
      // (`app/sessions/[kind]/[sessionId]/page.tsx:398`), so on this surface
      // `session-id` can only ever mean "the session you are looking at".
      // `data-session-kind` is on the root too. **No key `SessionMinted`
      // carries is reachable here**, so `<demoSessionId>` cannot be bound on
      // this page by any beat — which is why this beat no longer tries.
      //
      // What it CAN say honestly is that the handoff happened and minted
      // something: `stage-detail-stage` is carried by exactly one element, and
      // `action` is not on the root at all, so the value picks out
      // `SessionMinted`'s anchor — the way in that only exists once a session
      // has been created (`SessionMinted.tsx:19`, "No id, no element").
      //
      // Beat 8's fix SHIPPED (PR #490, bead `forge-8vfn.6.11.26`): the minted
      // id is published on `DemoTimeline`'s own root as `data-demo-session-id`,
      // the same rule `OnboardWithAgent` already followed. This beat binds it
      // below, which is what lets beat 8 reach its route at all.
      act: 'Select the demo stage and hand it to the demo builder — the heavy one',
      do: [{ press: 'select-stage-demo' }, { press: 'launch-demo-builder' }],
      expect: {
        route: '/sessions/onboarding/<sessionId>',
        data: {
          'stage-detail-stage': 'demo',
          action: 'view-demo-session',
          // AMENDED 2026-09-06 (T1 rulings 306/312, operator-confirmed). The
          // minted demo session id, published on `DemoTimeline`'s own root by
          // PR #490 under the DOM contract's own rule — a surface that starts a
          // session publishes the id on its own root, under a key no page root
          // shadows. Beat 8's `/sessions/demo/<demoSessionId>` could not be
          // reached before this: `SessionMinted`'s generic `data-session-id` is
          // shadowed by the ONBOARDING session page's root, so the key answered
          // with the wrong session and the segment stayed unbound.
          'demo-session-id': '<demoSessionId>',
        },
      },
      say: 'Not every contract component is a question and an answer. The demo process is a build in its own right, so it gets its own long-running session rather than blocking the onboarding one. Handing it over does not take the operator anywhere: the demo session is minted and named on the page they are standing on, so they can walk into it now or come back to it later.',
    },
    {
      // `view-demo-session` (`SessionMinted.tsx:26`) is a real handle and the
      // segment is bound: beat 7 publishes `data-demo-session-id` on
      // `DemoTimeline`'s own root (PR #490). That half has worked since.
      //
      // AMENDED 2026-09-07 (T1 ruling 364, the OPERATOR'S choice between two
      // honest repairs: "press brief and wait for a real `locked`"). This beat
      // asked for `session-phase: 'complete'` and pressed nothing but the way
      // in, and S1 run 9 finally proved — from #516's captured DOM,
      // `data-session-kind="demo"`, `data-session-phase="briefing"` — that it
      // could not have passed on any product, for TWO independent reasons.
      //
      // ONE: THE PHASE DOES NOT EXIST. `studio/session-kinds.yaml`'s `demo`
      // kind declares six rows and no others —
      //
      //   briefing (noop, awaits questions) · generating (agent, writes demo)
      //   · awaiting-review (noop, awaits verdict) · locking (finalize,
      //   recordLockedDemo) · locked (terminal) · abandoned (terminal)
      //
      // — so `complete` is not among them and never was. The demo kind's real
      // terminal for work that finished is `locked`; `abandoned` is the other
      // one, and it is not success.
      //
      // TWO: NOTHING BRIEFED THE BUILDER. Beat 7's `launch-demo-builder` posts
      // `/api/demo-builder/start` (`packages/sessions/bridge-studio-demo.ts`),
      // which validates, writes `phase: 'briefing'`, broadcasts and RETURNS —
      // it spawns nothing. The spawn is one route later at
      // `/api/demo-builder/brief`, which the `briefing` row's
      // `awaits: questions` renders the door for: an optional free-text box
      // (`data-field="session-answer"`) and `data-action="submit-answers"`,
      // labelled "Start →". So `briefing` was the CORRECT state at this beat,
      // twice over, and the old beat described an interaction the product does
      // not have.
      //
      // WHAT THE BEAT NOW WALKS is the flow the operator actually has: open
      // the session, give the builder its brief, and — when the generation
      // lands at `awaiting-review` — approve it, which finalises through
      // `locking` to `locked`. `data-action="verdict-approve"` renders from
      // the row's own `verdicts: [approve, revise, reject]` and that row
      // declares no `requires:`, so nothing gates the press.
      //
      // THE BRIEF IS FOCUS-ONLY, AND RUN 10 IS WHY (T1 ruling 367). The first
      // version of this brief said "Show the scan running end to end on this
      // repo and print the human-readable summary" — which reads as an
      // instruction to RUN things, and the agent did: S1 run 10's
      // `events.jsonl` holds 25 events, 24 of them `tool.Bash`, and no `end`,
      // against `maxTurns: 24`. It burned its whole turn ceiling running
      // commands and wrote neither required artifact, and the session reached
      // the terminal `failed` in 111 s with the product's own error naming what
      // was missing and saying "refine the guidance". §15.213 — the brief is
      // part of this amendment, so the amendment is the first suspect.
      //
      // So the brief now describes WHAT THE DEMO SHOULD SHOW AND WHY, and says
      // not to run the project. It is guidance, which is what the `briefing`
      // checkpoint is for; the deliverable belongs to the demo-design skill.
      //
      // THE PREDICTION, on the record before the next run spends: if a
      // focus-only brief ALSO exhausts 24 Bash turns, the brief was never the
      // cause and bead `forge-8vfn.6.11.49` — the demo builder's Bash ceiling —
      // is a P1 product defect rather than a P2 observation.
      //
      // THE BOUND IS THE LARGEST THE RUNNER PERMITS, and that is a statement
      // rather than a guess: the demo builder bounds its generation in TURNS
      // (`maxTurns: 24`, `packages/sessions/kinds/demo-builder.ts`), not in
      // milliseconds, so no ms figure can be DERIVED from the product. No run
      // has ever completed a demo generation, so there is no measurement to
      // use either. `MAX_DECLARED_WAIT_MS` it is, said out loud — and the
      // first green run replaces this with a measured number.
      act: 'Come back to the demo builder, brief it, and lock the demo it makes',
      do: [
        { press: 'view-demo-session' },
        {
          fill: 'session-answer',
          with:
            'The demo should show the end-to-end scan and the human-readable summary the quality gate checks — '
            + 'that is this project\'s one capability worth seeing, and what a newcomer needs in order to believe it works. '
            + 'Design and write the demo; do not run the project to find out.',
        },
        { press: 'submit-answers' },
        { press: 'verdict-approve' },
      ],
      wait: { for: 'agent', upTo: 1_800_000 },
      expect: {
        route: '/sessions/demo/<demoSessionId>',
        data: {
          page: 'session',
          'page-ready': 'true',
          'session-kind': 'demo',
          'session-phase': 'locked',
        },
      },
      say: 'Not every contract element is answered by talking. The demo is a build, so it gets its own long-running session: the operator briefs it, leaves, and comes back to a generated demo to approve. Approving locks it — the demo this project will be shown by from now on is a recorded artifact, not a screenshot somebody took once.',
    },
    {
      // Fully expressible, but only because the exit is itself a
      // `data-action`. `do` steps run on the page the operator is STANDING on,
      // before this beat's route is reached, so a "go there, then act" beat is
      // expressible only when the navigation is a step too —
      // `[data-action="back-to-project"]` renders on every session shell in
      // every phase (W7-A2), so it is.
      act: 'Return to the project and record a decision on the clause that needs the operator\'s judgement',
      // AMENDED 2026-09-05 (operator ruling 214 (a)+(b), T1 ruling 217), and
      // BOTH halves were defects no run could see until run 3 reached this
      // beat for the first time.
      //
      // (a) THE PRESS HAD NOTHING TO APPLY. `ContractResolutionPanel.tsx:270`
      // disables `apply-clause-decision` while `(notes[c.id] ?? '').trim() ===
      // ''`; the operator types the decision into
      // `[data-field="clause-decision-<clauseId>"]` (:262) first. Run 3's own
      // log names the clause — `locator resolved to <button disabled
      // data-apply-clause-id="C1b" …>` — so the fill is `clause-decision-C1b`
      // and not a guess. C1b is the CI mirror clause, and gitweave's
      // post-auto-fix contract carries `testProcess.local` and no `ci`.
      //
      // (b) THE COUNT WAS UNSATISFIABLE BY CONSTRUCTION. The pinned
      // `resolution-failing-count: '0'` asked for a value only the element's
      // ABSENCE can produce: `ContractResolutionPanel.tsx:180` is `if
      // (failing.length === 0) return null` and `:185` carries the count, so
      // at zero no element carries the key at all — `beats.mjs`'s resolver
      // sends it to `shared`, every record scores 0, and the beat reds on a
      // key that cannot exist. §15.175, the same trap the H6 sitting fixed in
      // S2 beat 5 and S3 beat 5 and left here because no run had reached beat
      // 9.
      //
      // The replacement values are MEASURED, not chosen: on a restored
      // gitweave copy carrying run 3's `.forge/`, `applyPreflightAutoFixes`
      // (the function this beat's second press calls) cleared C2 and C4 — the
      // only two HARD clauses — taking `runPreflight().ok` false → true and
      // failing 6 → 4; declaring `testProcess.ci`, which is the C1b decision's
      // whole job, leaves `ok: true` with failing 3 / user 0 / agent 3 (C8,
      // DEMO-SKILL, DEMO-ALIGN). So readiness and the counts are true
      // TOGETHER, which is why they sit in one beat (ruling 217, branch (ii)),
      // and `section: 'contract-resolution'` is named so a future zero cannot
      // silently revert this beat to §15.175's trap.
      //
      // ── AMENDED 2026-09-06 (T1 ruling 306, operator-confirmed: "measure it,
      // don't choose it"). RE-MEASURED against what onboarding leaves TODAY,
      // and two things moved. Full working:
      // `_1.0/evidence/m5-b-S1-beat9-measurement.md`.
      //
      // (c) `apply-preflight-auto` IS REMOVED, because there is nothing left
      // for it to apply. The AUTO tier is EMPTY after onboarding — measured
      // `auto: []`, and run 5's ground diff is exactly `.gitignore` (+5, the
      // forge-scratch block C2 wants) and `CLAUDE.md` (the C1 gate command),
      // i.e. the onboarding agent now performs those edits itself.
      // `ContractResolutionPanel` renders that control only while an auto-tier
      // clause fails, so run 5 waited its whole 200 000 ms bound for a control
      // the product is CORRECT not to render. The beat was asserting a path
      // the product no longer takes (§15.204) — not a product bug, and not a
      // consequence of the `6.11.26` escape, which is its own defect.
      //
      // (d) THE COUNTS MOVE 3/0/3 → 2/0/2. State B (what onboarding leaves) is
      // `ok: true`, failing 3 = C1b + DEMO-SKILL + DEMO-ALIGN, tiers auto 0 /
      // agent 2 / user 1. The C1b decision clears C1b — `checkC1b` passes iff
      // `testProcess.ci` is declared, which is exactly what the fix writes — so
      // state C is failing 2 / user 0 / agent 2. C8 is no longer among them:
      // onboarding now writes the gate command into `CLAUDE.md` itself.
      // Two is still non-zero, so `:180`'s `if (failing.length === 0) return
      // null` keeps the section mounted and §15.175's trap stays shut.
      //
      // `flow-ready: 'true'` and `ready-count: '5'` are measured too, and the
      // reason matters: all five `uiChecks` pass because onboarding binds
      // `skills: ['demo-design']`. Session 5 recorded that "the onboarding
      // agent never binds a skill" and that `flow-ready: true` was therefore
      // unreachable on gitweave — that finding is now STALE, superseded by
      // this measurement rather than left standing.
      //
      // ── AMENDED 2026-09-06, amendment 8 (operator ruling 329, adopted as
      // drafted by T1 ruling 335, repaired by T1 ruling 337). THE COUNTS ARE
      // GONE. What replaces them is what is STABLE about this page: preflight
      // is MET, the project is Flow-ready, and C1b's row is present as the
      // operator's to resolve.
      //
      // (e) WHY NO COUNTS. The counts moved under this beat three times in
      // three sessions — `3/0/3` (ruling 217), `2/0/2` (ruling 306), and run 7
      // read `3` and `1` because the C1b agent had not landed inside the
      // panel's own 180 s poll ceiling. A count is a fact about how far a
      // dispatched agent got by the moment the page was read; asserting it
      // makes the story a stopwatch. `clause-id`/`clause-resolution` are facts
      // about WHAT C1b IS — the one clause only the operator can decide — and
      // they do not move.
      //
      // (f) THE BEAT DOES NOT ASSERT C1b's ROW GONE after the decision
      // (ruling 335 a). The decision's 200 s timeout is a PRODUCT observation,
      // bead `forge-8vfn.6.11.31`, never story tuning.
      //
      // (g) `section: 'contract-resolution'` WAS in the drafted set and is NOT
      // here, and this is measured, not preferred. `_1.0/evidence/m5-b-probe178/`
      // — a costless throwaway story ($0.0000, nothing dispatched) driven
      // through the runner's OWN resolver on a live `/projects/gitweave`
      // reconstructed to state B — read four expectation sets on the same page
      // moments apart: `clause-id` + `clause-resolution` GREEN; the same pair
      // PLUS `section` RED with `data-section: expected "contract-resolution",
      // absent from the page`; the full drafted set RED on that one key; the
      // set below GREEN. `resolveExpectations` puts a key carried by two or
      // more elements under the together-rule, six elements on this page carry
      // `section`, and one `ClauseRow` per failing clause carries `clause-id`
      // — so no element carries all three and the best-covering candidate
      // (C1b's row) wins, reporting `section` absent. §15.178.
      //
      // Nothing is lost. `ClauseRow` renders ONLY inside
      // `[data-section="contract-resolution"]` (`ContractResolutionPanel.tsx:322`),
      // so `clause-id: 'C1b'` already says the panel is up — and it keeps
      // §15.175's trap shut for the reason the count used to: at zero failing
      // clauses `:180` returns null, no row renders, and this beat reds.
      do: [
        { press: 'back-to-project' },
        {
          fill: 'clause-decision-C1b',
          with: "GitWeave's CI mirror is the same command the per-WI gate runs — declare testProcess.ci as python -m pytest tests/. There is no separate build step, so C1b is satisfied by making the mirror explicit rather than by inventing a second command.",
        },
        { press: 'apply-clause-decision' },
      ],
      // AMENDED 2026-09-05 (T1 ruling 230; ruling 200's mechanical class as
      // extended by 222). A `wait` field changes no expectation and no act —
      // it names the bound the beat is judged under.
      //
      // THIS BEAT STANDS ON A REAL AGENT, and amendment 3 gave the declaration
      // only to beat 6. `apply-clause-decision`'s handler is `submitUser`
      // (`ContractResolutionPanel.tsx:161`), which calls `preflightFixAgent`
      // and polls the run it dispatches; the panel's own header says so — "this
      // tier — and only this tier — genuinely dispatches + polls an agent
      // turn". Run 4 pressed it for the first time in the story's life and read
      // the counts back at STATE B (`failing 4 / user 1`), i.e. before the
      // decision landed, because the runner gave an agent's work the 15 s
      // bound meant for a DOM update. §15.183 a second time, in this story.
      //
      // 200 000 ms is MEASURED, not guessed: the panel's own poll ceiling is
      // `DEFAULT_POLL_INTERVAL_MS 2000 × DEFAULT_POLL_MAX_ATTEMPTS 90` = 180 s
      // (`apps/studio/lib/agent-dispatch.ts:49,51`), after which it renders
      // `data-poll-state="timed-out"` with a `re-check` affordance and these
      // counts can never move from that poll. A bound above the product's own
      // bound would buy nothing, so the beat waits exactly as long as the
      // product is still able to answer, plus a margin for the re-render.
      wait: { for: 'agent', upTo: 200_000 },
      expect: {
        route: '/projects/gitweave',
        data: {
          page: 'projects',
          'project-id': 'gitweave',
          'preflight-status': 'ok',
          'flow-ready': 'true',
          'clause-id': 'C1b',
          'clause-resolution': 'user',
        },
      },
      say: 'Preflight is MET. GitWeave now has a contract forge can hold it to, and the project is Flow-ready: the gates downstream have something real to judge against.',
    },
    {
      // AMENDED 2026-09-05 (H6, operator present) — expressible, and it always
      // was the same shape as the demo handoff two beats up. `NewIdeaBox`'s
      // `start-architect` does NOT push the minted id into a route: it sets
      // `startedSessionId` and publishes it on its own section
      // (`NewIdeaBox.tsx:111`), then renders `SessionMinted` beside it
      // (`:187`). `ProjectArchitectEntry.tsx:84` opens that box INLINE on the
      // project page, so every step of this act happens on `/projects/gitweave`
      // and the id is bound where it is minted. The beat that stood here
      // asserted the architect session's own phase and could never reach it —
      // no earlier beat could supply the segment, so nothing was ever pressed
      // and no Architect was ever started. Its `session-phase` assertion is
      // not re-homed: the beat below walks through that session to the plan
      // gate and asserts `architect-phase` there, which is the same fact read
      // where the operator actually decides on it.
      act: 'Press "Plan with Architect" and describe the first piece of work',
      // AMENDED 2026-09-05 (ruling 214 (c) as re-scoped by ruling 215). Run 3
      // reported `no element carries that handle` for `plan-with-architect` —
      // a handle `ProjectArchitectEntry` renders UNCONDITIONALLY, in every
      // branch of `[data-section="project-roadmap"]`. It was one tab away: the
      // project page's tab buttons carried `data-tab`/`data-tab-active` and no
      // `data-action`, and `beats.mjs` resolves `[data-action=…]` only, so no
      // story could reach the roadmap tab. Bead `forge-8vfn.6.11.9` (#436)
      // declared it; this presses it.
      do: [
        { press: 'project-tab-roadmap' },
        { press: 'plan-with-architect' },
        { fill: 'idea', with: IDEA },
        { fill: 'cost-ceiling-usd', with: CEILING },
        { press: 'start-architect' },
      ],
      expect: {
        route: '/projects/gitweave',
        data: {
          page: 'projects',
          'project-id': 'gitweave',
          section: 'new-idea',
          'architect-session-id': '<architectSessionId>',
        },
      },
      say: 'With a contract in place the Architect can plan. It interviews the operator, reads the project, and produces a roadmap for review — the first Gate a human stands at. A real Agent costs money, so the operator caps this run before starting it, and forge names the session it just minted on the page they are standing on rather than sweeping them into it.',
    },
    {
      // Fully expressible. `/artifact` is reached by a query-string href, so
      // the runner's `a[href="/artifact"]` fallback would not match it — the
      // navigation is a `do` step (`[data-action="open-plan"]`,
      // `SessionArchitectPanel.tsx`) and the approval follows it on the page
      // it lands on (`[data-action="approve-plan"]`, `PlanGate.tsx`).
      //
      // AMENDED 2026-09-05 (H6, operator present) — one press added at the
      // front. The beat above now binds `<architectSessionId>` on the project
      // page rather than being swept into the session, so this beat starts on
      // `/projects/gitweave` and `open-plan` is not there — it is on the
      // architect session's panel. `SessionMinted.tsx:26` renders
      // `[data-action="view-architect-session"]` beside the id the beat above
      // bound, so the walk in is a declared step like the other two. Three
      // presses, three surfaces, all named by the product.
      act: 'Open the session, read the plan and press Approve',
      // AMENDED 2026-09-06 (T1 rulings 312/317, operator-confirmed). THE
      // ARCHITECT INTERVIEWS BEFORE IT PLANS, and it decides how many ROUNDS it
      // needs — `bridge-studio-architect.ts:380` writes `{ phase:
      // 'interviewing', round: round + 1 }` and spawns another turn on every
      // submission, with no ceiling anywhere in the product (bead
      // `forge-8vfn.6.10.28`). Measured on S4 run 4: `round: 2` with one round
      // of answers recorded, red at `awaiting-answers` after the full bound.
      //
      // So `repeat` answers rounds UNTIL the phase leaves the interview,
      // bounded by this beat's own declared wait — never a fixed count, which
      // is wrong in BOTH directions: too few never reaches the draft, and too
      // many press `submit-answers`, which exists only while the session awaits
      // answers (`studio/session-kinds.yaml:88` is the only row declaring
      // `awaits: questions`), so the surplus press reds on a control that is
      // correctly gone.
      do: [
        { press: 'view-architect-session' },
        // `until` is the INTERVIEW's end, not this beat's. AMENDED 2026-09-06
        // (T1 ruling 320) after S1 run 6 burned its whole bound here: the
        // repeat borrowed `expect.data`, which is `architect-phase:
        // 'committed'` — produced by `approve-plan`, two steps LATER — so it
        // could never stop by answering questions. `status.json` showed the
        // product was right all along (`phase: "awaiting-verdict", round: 2`,
        // one round answered): the architect drafted, and the loop kept
        // submitting to a session that had moved on.
        {
          repeat: [{ fillAll: 'question-freetext', with: ANSWER }, { press: 'submit-answers' }],
          until: { 'session-phase': 'awaiting-verdict' },
        },
        { press: 'open-plan' },
        { press: 'approve-plan' },
      ],
      wait: { for: 'agent', upTo: 600_000 },
      expect: {
        route: '/artifact',
        data: {
          'section': 'architect-plan',
          'architect-phase': 'committed',
          'gate-armed': 'false',
          // AMENDED 2026-09-11 (amend-10) — was `'gate'`, which this beat can
          // never see. `SessionArchitectPanel.tsx:147` builds the plan href as
          // `phase === 'awaiting-verdict' ? 'gate' : 'view'`, so APPROVING IS
          // WHAT ENDS GATE MODE — and this beat's last `do` step is
          // `{ press: 'approve-plan' }`. It was asserting the gate it had just
          // closed, beside `architect-phase: 'committed'`, which only exists
          // BECAUSE the gate closed. The two keys could not both hold.
          //
          // S1 run 3 proved the product right and the beat wrong, and said so
          // in the shape of the red: it named ONE token, `plan-mode`, which
          // means `architect-phase: 'committed'` and `gate-armed: 'false'`
          // both HELD. The approval worked. A red that names one of three keys
          // is reporting that the other two passed.
          //
          // Lane C measured the identical token on S10 beat 5 (run 4 red at
          // 10:55:32 while `status.json` had gone COMMITTED at 10:55:17.386 —
          // the approval had already landed); their amend-3 declared `'view'`
          // and beat 5 went green in 3.1 s.
          'plan-mode': 'view',
        },
      },
      say: 'The plan is approved and committed. An existing repo that forge knew nothing about half an hour ago is now an onboarded project with a contract, a demo, a knowledge profile and an approved roadmap — ready for a Factory to build.',
    },
  ],
};
