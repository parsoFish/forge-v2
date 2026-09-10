/**
 * beats.test.ts — the story runner's per-beat verdict.
 *
 * These are ACCEPTANCE tests, pinned before the implementation
 * (`_1.0/gate-manifests/M1-B.txt`). Each one names the wrong implementation it
 * kills, because a test that would look identical had the implementation been
 * wrong is characterization, not acceptance.
 *
 * The defect class every case here exists to make impossible: a beat that
 * cannot find the state it asserted reporting green anyway. That is the
 * `declared-data-fails-open` family — a value parsed and surfaced but enforced
 * nowhere — and it is the single most-repeated finding of the wave-4 and
 * wave-8 campaigns. A story is a gate; a gate that reports green having not
 * looked is worse than no gate at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatVerdict, resolveBeatRoute, stuckVerdict } from './beats.mjs';

const beat = {
  act: 'Click through to the Projects pillar',
  expect: { route: '/projects', data: { 'page-ready': 'true', 'project-count': '3' } },
  say: 'The Projects pillar lists every project forge manages.',
};

test('a beat whose route and every data-* expectation hold is green', () => {
  const v = beatVerdict(beat, { route: '/projects', data: { 'page-ready': 'true', 'project-count': '3' } });
  assert.equal(v.status, 'green');
  assert.deepEqual(v.failures, []);
});

test('a beat whose data-* expectation FAILS returns a red verdict naming the attribute and both values', () => {
  // Kills: a verdict that compares nothing, or reports the mismatch without
  // saying which attribute or what it expected — an operator reading the run
  // must not have to re-run it to find out what broke.
  const v = beatVerdict(beat, { route: '/projects', data: { 'page-ready': 'true', 'project-count': '0' } });
  assert.equal(v.status, 'red');
  assert.equal(v.failures.length, 1);
  assert.match(v.failures[0], /project-count/);
  assert.match(v.failures[0], /expected "3"/);
  assert.match(v.failures[0], /got "0"/);
});

test('a MISSING data-* attribute is red and says absent — never treated as a pass', () => {
  // Kills the fail-open implementation: `if (observed[k] && observed[k] !== want)`,
  // which lets an attribute the UI never rendered slip through as green. This is
  // the exact shape of M0's merge-gate `catch -> return { ok: true }` and of
  // M1-D's brain lint reporting 0 errors having skipped Brain 3 entirely.
  const v = beatVerdict(beat, { route: '/projects', data: { 'page-ready': 'true' } });
  assert.equal(v.status, 'red');
  assert.equal(v.failures.length, 1);
  assert.match(v.failures[0], /project-count/);
  assert.match(v.failures[0], /absent/);
});

test('an empty observation is red on every expectation, not silently green', () => {
  // Kills: a verdict that iterates the OBSERVED keys instead of the EXPECTED
  // ones. That implementation passes all of the above and still reports green
  // for a page that rendered nothing at all.
  const v = beatVerdict(beat, { route: '/projects', data: {} });
  assert.equal(v.status, 'red');
  assert.equal(v.failures.length, 2);
});

test('landing on the wrong route is red even when every data-* matches', () => {
  // Kills a verdict that checks only attributes: real nav can land somewhere
  // unintended while the asserted attributes happen to exist on that page too.
  const v = beatVerdict(beat, { route: '/', data: { 'page-ready': 'true', 'project-count': '3' } });
  assert.equal(v.status, 'red');
  assert.match(v.failures.join(' '), /route/);
  assert.match(v.failures.join(' '), /\/projects/);
});

test('every failed expectation is reported, not just the first', () => {
  // Kills a short-circuiting verdict. An operator must see the whole truth of
  // one run, not discover the next broken expectation one re-run at a time.
  const v = beatVerdict(beat, { route: '/', data: {} });
  assert.equal(v.failures.length, 3);
});

test('the verdict carries the narration and act forward for the doc fragment', () => {
  // The triple output (verdict, clip, doc) comes from ONE script; the doc
  // fragment reads these fields off the verdict, so they must survive it.
  const v = beatVerdict(beat, { route: '/projects', data: { 'page-ready': 'true', 'project-count': '3' } });
  assert.equal(v.act, beat.act);
  assert.equal(v.say, beat.say);
});

test('the verdict is frozen and does not mutate the beat it judged', () => {
  const input = structuredClone(beat);
  const v = beatVerdict(input, { route: '/x', data: {} });
  assert.ok(Object.isFrozen(v));
  assert.deepEqual(input, beat);
});

// ---------------------------------------------------------------------------
// Settled != succeeded. Found by adversarial review, 2026-08-29.
// ---------------------------------------------------------------------------

test('a page that SETTLED INTO AN ERROR is red, even though every declared expectation holds', () => {
  // THE DEFECT THIS KILLS, and it is the campaign's headline class. The
  // product's own convention (`components/PageLoadError.tsx`, and
  // `ProjectsIndex.tsx:115`: `error ? 'error' : ready ? 'ok' : 'loading'`) is
  // that a route whose fetch THREW still renders its own data-page and
  // `data-page-ready="true"` — it HAS settled, into an honest failure — and
  // says so via `data-fetch-status="error"`.
  //
  // So a beat asserting only {page, page-ready} — which is exactly what the
  // shipped smoke story asserted — goes GREEN against a visibly broken page.
  // The runner must judge the error sentinels whether or not the story
  // author remembered them; relying on nine story authors to each remember
  // is how this class survives.
  const v = beatVerdict(beat, {
    route: '/projects',
    data: { 'page-ready': 'true', 'project-count': '3', 'fetch-status': 'error' },
  });
  assert.equal(v.status, 'red');
  assert.match(v.failures.join(' '), /fetch-status/);
});

test('data-load-error="true" is red on the same grounds', () => {
  const v = beatVerdict(beat, {
    route: '/projects',
    data: { 'page-ready': 'true', 'project-count': '3', 'load-error': 'true' },
  });
  assert.equal(v.status, 'red');
  assert.match(v.failures.join(' '), /load-error/);
});

test('a story that DELIBERATELY asserts the error state is honoured, not overridden', () => {
  // The escape hatch: a story about the error surface itself must be able to
  // assert it. The invariant only fires on an error the story did not ask for.
  const errorBeat = {
    act: 'See the honest failure when the roster read fails',
    expect: { route: '/projects', data: { 'fetch-status': 'error' } },
    say: 'The page says it could not load, instead of pretending to be empty.',
  };
  const v = beatVerdict(errorBeat, { route: '/projects', data: { 'fetch-status': 'error' } });
  assert.equal(v.status, 'green');
});

test('fetch-status "ok" and "loading" are not treated as errors', () => {
  const ok = beatVerdict(beat, {
    route: '/projects',
    data: { 'page-ready': 'true', 'project-count': '3', 'fetch-status': 'ok' },
  });
  assert.equal(ok.status, 'green');
});

// ── M1-F: nested `data-*` and prior-beat route segments (bead forge-8vfn.2.17)
//
// `docs/forge-ui-dom-and-harness.md` states that nested `data-*` IS the
// contract — the project card is
// `a[data-card-type="project"][data-card-id][data-health]`, not an attribute of
// `main[data-page]`. The shipped reader queried `main[data-page]` only, so the
// runner's read scope was narrower than the contract it judged, and S1 beat 1
// reported "absent from the page" about state the page plainly rendered.
//
// The split is deliberate: the READER stays value-blind (it collects by key),
// and every value judgement lives here, in the pure function.

const cardBeat = {
  act: 'Open Studio on the Projects pillar',
  expect: {
    route: '/projects',
    data: { page: 'projects-index', 'card-id': 'gitweave', health: 'attention' },
  },
  say: 'GitWeave is discovered from disk but needs attention.',
};

// The live DOM of `/projects`, booted from this lane's worktree on 2026-08-30.
const liveProjectsIndex = {
  route: '/projects',
  data: { page: 'projects-index' },
  nested: [
    { 'card-id': 'gitweave', health: 'attention' },
    { 'card-id': 'mdtoc', health: 'healthy' },
  ],
};

test('a data-* expectation the page renders on a NESTED element is satisfied', () => {
  // Kills the shipped reader's scope: `card-id` and `health` live on the card,
  // never on `main`, and reporting them absent is a false red about the harness
  // dressed as a product gap.
  const v = beatVerdict(cardBeat, liveProjectsIndex);
  assert.equal(v.status, 'green', v.failures.join(' | '));
});

test('nested expectations must be satisfied by ONE element, not assembled from two', () => {
  // Kills per-key existential matching. With gitweave healthy and mdtoc needing
  // attention, "the gitweave card needs attention" is FALSE, but a reader that
  // answers each key independently reports it true — the fail-open shape this
  // module exists to prevent, one layer down from the root.
  const v = beatVerdict(cardBeat, {
    route: '/projects',
    data: { page: 'projects-index' },
    nested: [
      { 'card-id': 'gitweave', health: 'healthy' },
      { 'card-id': 'mdtoc', health: 'attention' },
    ],
  });
  assert.equal(v.status, 'red');
});

// ── M5-B s2: keys the page splits across two SIBLING elements (ruling 163,
// bead forge-8vfn.9, measured by `_1.0/evidence/m5-b-probe9/`).
//
// `/projects/<id>` renders `data-preflight-status` on ContractReadiness's own
// div and `data-checklist-row`/`data-checklist-status` on ProjectContractPanel
// `<li>`s. They are siblings: no single element carries both. Reading S1 beat
// 3's exact key set reported `data-preflight-status` "absent from the page"
// while a probe reading that key ALONE, on the same page moments later, found
// it — so the absence was the runner's, and the bead blaming the product for
// declaring `page-ready` too early is refuted.
//
// The relaxation is bounded by SOURCE COUNT, not by convenience: a key exactly
// one element on the page carries names no competing entity, so reading it
// from its own element cannot pick the wrong one. A key two elements carry is
// exactly the gitweave/mdtoc ambiguity above and stays under the together-rule.

/** The live DOM of `/projects/gitweave` right after onboarding (probe9, 2026-09-05). */
const liveProjectPage = {
  route: '/projects/gitweave',
  data: { page: 'projects', 'project-id': 'gitweave', 'page-ready': 'true' },
  nested: [
    { section: 'contract-readiness', 'preflight-status': 'hard-fail' },
    { section: 'contract-checklist', 'checklist-row-count': '5' },
    { 'checklist-row': 'contract', 'checklist-status': 'absent' },
    { 'checklist-row': 'instructions', 'checklist-status': 'present' },
    { 'checklist-row': 'secrets', 'checklist-status': 'absent' },
  ],
};

/** S1 beat 3's expectation set, verbatim from the pinned story. */
const siblingBeat = {
  act: 'Fill in the form and press "Onboard project →"',
  expect: {
    route: '/projects/gitweave',
    data: {
      page: 'projects',
      'project-id': 'gitweave',
      'page-ready': 'true',
      'preflight-status': 'hard-fail',
      'checklist-row': 'contract',
      'checklist-status': 'absent',
    },
  },
  say: 'Forge measures GitWeave against the contract and reports a hard fail.',
};

test('a key only ONE element on the page carries is read from it, even when another element answers the rest', () => {
  // Kills "one best record decides every missing key". The best-covering
  // record is a checklist `<li>`, which cannot carry `preflight-status` at
  // all; before this, the beat failed naming a key the page plainly rendered.
  const v = beatVerdict(siblingBeat, liveProjectPage);
  assert.equal(v.status, 'green', v.failures.join(' | '));
});

test('a key several elements carry is still answered by ONE element, not assembled', () => {
  // Kills the over-wide fix: `checklist-row` and `checklist-status` are each
  // carried by three `<li>`s, so "the contract row is present" must be true of
  // ONE row. `contract` is absent and `instructions` is present; assembling
  // the pair across the two would report a row that does not exist.
  const v = beatVerdict(
    { ...siblingBeat, expect: { ...siblingBeat.expect, data: { ...siblingBeat.expect.data, 'checklist-status': 'present' } } },
    liveProjectPage,
  );
  assert.equal(v.status, 'red');
  assert.ok(
    v.failures.some((f) => /checklist-status.*expected "present", got "absent"/.test(f)),
    v.failures.join(' | '),
  );
});

test('a nested expectation nothing on the page carries is still red, and says absent', () => {
  const v = beatVerdict(cardBeat, { route: '/projects', data: { page: 'projects-index' }, nested: [] });
  assert.equal(v.status, 'red');
  assert.ok(v.failures.some((f) => /card-id.*absent from the page/.test(f)), v.failures.join(' | '));
});

test('main\'s own attribute still wins over a nested element carrying the same key', () => {
  // The page root is the page's own statement about itself. A nested element
  // must never be able to overrule it — that would let a stale card satisfy a
  // page-level assertion.
  const v = beatVerdict(
    { ...cardBeat, expect: { route: '/projects', data: { page: 'projects-index' } } },
    { route: '/projects', data: { page: 'projects-index' }, nested: [{ page: 'not-found' }] },
  );
  assert.equal(v.status, 'green', v.failures.join(' | '));
});

test('an observation with no nested records at all behaves exactly as before', () => {
  // Every story authored before this lane, and every beat asserting only
  // page-root state, must be judged identically.
  const v = beatVerdict(beat, { route: '/projects', data: { 'page-ready': 'true', 'project-count': '3' } });
  assert.equal(v.status, 'green', v.failures.join(' | '));
});

// ── Binding a route segment a prior beat produced.
//
// The pinned S1 already writes the convention: beat 4 declares
// `'onboard-session-id': '<sessionId>'` and beats 5-6 route
// `/sessions/onboarding/<sessionId>`. The shipped shape is that one.

const bindBeat = {
  act: 'Press "Run onboarding agent"',
  expect: { route: '/projects/gitweave', data: { 'onboard-session-id': '<sessionId>' } },
  say: 'An Agent fills the contract in.',
};

test('a <name> expectation is satisfied by any value and binds it for later beats', () => {
  const v = beatVerdict(bindBeat, {
    route: '/projects/gitweave',
    data: {},
    nested: [{ 'onboard-session-id': 'onb-7f3c1a' }],
  });
  assert.equal(v.status, 'green', v.failures.join(' | '));
  assert.equal(v.bindings.sessionId, 'onb-7f3c1a');
});

test('a <name> expectation the page answers with an EMPTY value is red, not bound', () => {
  // Kills "any value at all": an id attribute rendered as "" is a product that
  // minted nothing, and binding it would put an empty segment in a later route.
  const v = beatVerdict(bindBeat, { route: '/projects/gitweave', data: { 'onboard-session-id': '' }, nested: [] });
  assert.equal(v.status, 'red');
  assert.deepEqual(v.bindings, {});
});

test('a <name> expectation the page does not render at all is red and says absent', () => {
  const v = beatVerdict(bindBeat, { route: '/projects/gitweave', data: {}, nested: [] });
  assert.equal(v.status, 'red');
  assert.ok(v.failures.some((f) => /onboard-session-id.*absent/.test(f)), v.failures.join(' | '));
});

test('a <name> an earlier beat already bound is COMPARED, not silently re-bound', () => {
  // Kills the shipped behaviour: `bindings[name] = got` was unconditional, so a
  // beat re-declaring a placeholder to RE-ASSERT the value overwrote it instead
  // and asserted nothing. Measured on S9: beat 8 bound `authoringCostUsd` from
  // the authoring session's own page (0.71), beat 15 re-declared it against
  // `/monitor` and rebound it to 0.39 — the beat that exists to prove the
  // figure is published stopped comparing the figure, then failed on its OTHER
  // key and reported `data-ledger-agent: expected "creation-agent", got
  // "onboarding-agent"`, which reads as "the wrong agent ran". The real defect
  // was that the authoring session has no /monitor row at all
  // (`forge-b6af`). A story that binds a value and re-declares it is asserting
  // a THIRD thing — that the two places agree — and that assertion was being
  // thrown away.
  const v = beatVerdict(bindBeat, { route: '/projects/gitweave', data: { 'onboard-session-id': 'onb-OTHER' }, nested: [] }, { bound: { sessionId: 'onb-7f3c1a' } });
  assert.equal(v.status, 'red');
  assert.ok(
    v.failures.some((f) => /onb-7f3c1a/.test(f) && /onb-OTHER/.test(f) && /sessionId/.test(f)),
    `the failure must name the earlier value, the new one and the placeholder — got: ${v.failures.join(' | ')}`,
  );
});

test('a <name> already bound to the SAME value the page answers is green', () => {
  const v = beatVerdict(bindBeat, { route: '/projects/gitweave', data: { 'onboard-session-id': 'onb-7f3c1a' }, nested: [] }, { bound: { sessionId: 'onb-7f3c1a' } });
  assert.equal(v.status, 'green', v.failures.join(' | '));
});

test('a <name> NOTHING has bound yet still binds — comparing did not replace binding', () => {
  // The positive control. Without it, an implementation that compared against
  // an empty `bound` and never wrote would pass both cases above.
  const v = beatVerdict(bindBeat, { route: '/projects/gitweave', data: { 'onboard-session-id': 'onb-first' }, nested: [] }, { bound: {} });
  assert.equal(v.status, 'green', v.failures.join(' | '));
  assert.equal(v.bindings.sessionId, 'onb-first');
});

test('resolveBeatRoute substitutes a segment an earlier beat bound', () => {
  const beat5 = { ...bindBeat, expect: { route: '/sessions/onboarding/<sessionId>', data: { page: 'session' } } };
  const r = resolveBeatRoute(beat5, { sessionId: 'onb-7f3c1a' });
  assert.equal(r.route, '/sessions/onboarding/onb-7f3c1a');
  assert.equal(r.unbound, null);
});

test('resolveBeatRoute refuses a placeholder no earlier beat bound, naming it', () => {
  // Kills a silent literal: navigating to the text "/sessions/demo/<demoSessionId>"
  // would 404 and the beat would blame the product for a story-authoring gap.
  const beat7 = { ...bindBeat, expect: { route: '/sessions/demo/<demoSessionId>', data: { page: 'session' } } };
  const r = resolveBeatRoute(beat7, { sessionId: 'onb-7f3c1a' });
  assert.equal(r.unbound, 'demoSessionId');
});

test('resolveBeatRoute leaves a route with no placeholder untouched', () => {
  const r = resolveBeatRoute(beat, {});
  assert.equal(r.route, '/projects');
  assert.equal(r.unbound, null);
});

test('a beat that never reached its page exports NO bindings', () => {
  // A beat can be red for three reasons that all leave the browser on the
  // PREVIOUS page: a `do` step that could not act, no real-nav path, and a
  // control that was not actionable. All three read that previous page to
  // report it honestly — and must not export a `<name>` binding harvested
  // there, or a later beat navigates to a segment the wrong page supplied and
  // can go GREEN on it. That is the fail-open this module exists to prevent,
  // reached through the new verb.
  const v = stuckVerdict(bindBeat, { route: '/projects/new', data: { 'onboard-session-id': 'stale-id' }, nested: [] }, 'could not press it');
  assert.equal(v.status, 'red');
  assert.deepEqual(v.failures, ['could not press it']);
  assert.deepEqual(v.bindings, {});
});

test('stuckVerdict still reports the page it was stuck on, for the operator reading the run', () => {
  const v = stuckVerdict(bindBeat, { route: '/projects/new', data: { page: 'projects' }, nested: [] }, 'no real-nav path');
  assert.equal(v.data.page, 'projects');
});

test('the verdict carries the NESTED values it judged, so the generated doc documents them', () => {
  // The how-to fragment renders `verdict.data` as its "what you should see"
  // list. Reading only the page root there means a beat can assert
  // `data-card-id="gitweave"` and the generated documentation never mentions
  // it — the tests, demos and docs drifting apart inside the one script §3
  // built to stop exactly that.
  const v = beatVerdict(cardBeat, liveProjectsIndex);
  assert.equal(v.data['card-id'], 'gitweave');
  assert.equal(v.data.health, 'attention');
  assert.equal(v.data.page, 'projects-index');
});
