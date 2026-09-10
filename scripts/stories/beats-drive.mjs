/**
 * beats-drive.mjs — the story runner's BROWSER CHOREOGRAPHY.
 *
 * Split out of `beats.mjs` when T1 ruling 438 took that file to 825 lines,
 * over the 800-line cap. The seam is the one the TESTS have used since
 * 2026-09-05: `beats.test.ts` pins the PURE verdict (`beatVerdict`,
 * `resolveBeatRoute`, `stuckVerdict`) against observations handed to it, and
 * `beats-drive.test.ts` pins `driveBeat` against a fake Studio — the press, the
 * fill and the wait that PRODUCE those observations. This file is that second
 * half; not one line of behaviour changed in the move.
 *
 * By concern and not by line count (ruling 150), and NO BASELINE was taken:
 * `beats.mjs` had been sitting at 799 of 800 lines, so the next change to it —
 * any change — was going to pay this bill. Baselining would have moved the
 * cap's own floor and left the file exactly as unmanageable.
 *
 * The dependency runs ONE WAY: this module imports the pure half, and the pure
 * half imports nothing from here. A barrel re-export would have made a cycle,
 * and a cycle in the module that judges every beat is not worth the seven
 * import lines it would have saved.
 */
import {
  PLACEHOLDER, answers, resolveExpectations, readObserved, routeMatches, destinationKey,
  waitForConsequence, waitForHandleOrStall,
} from './beats-page.mjs';

// `routeMatches` LIVES in `beats-page.mjs` and is re-exported here (T1 ruling
// 518). It moved because `stopReasonFor` must decide whether a beat is standing
// on the session it is scoped to, and that is the same question — a string
// equality there while every compare here went through the predicate is exactly
// the split 514 existed to close, one function further down. `beats-drive`
// imports `beats-page`, never the reverse, so the leaf holds it and the caller
// re-exports for the modules and tests that already name it here.
export { routeMatches };
import {
  READY_TIMEOUT_MS, beatBound, withAgentProc, beatVerdict, stuckVerdict, resolveBeatRoute,
} from './beats.mjs';
// `performSteps` moved to `beats-steps.mjs` at the 800-line cap (ruling 492).
// `driveBeat` calls it and nothing there calls back — that one-way dependency is
// why the split went this way round and not the other.
import { performSteps } from './beats-steps.mjs';


/**
 * `page.waitForURL` whose PREDICATE cannot fail silently.
 *
 * T1 ruling 553, bought by 546's own CI red. Both call sites wrote
 * `.waitForURL((u) => routeMatches(u, target), …).catch(() => {})`, and that
 * catch is deliberate: a press that did not navigate must be reported by the
 * nav resolution below, not by an exception. But it also swallowed **the
 * predicate throwing**, which is never a legitimate outcome — and that is
 * exactly what happened when 546 added `url.startsWith('#')` to
 * `routeMatches`:
 *
 *   playwright hands the predicate a URL **OBJECT**, not a string. So
 *   `.startsWith` was not a function, the predicate threw, `waitForURL`
 *   rejected, the catch ate it, NO ARRIVAL WAIT HAPPENED AT ALL, and every
 *   real-nav beat then read its page before the navigation committed. The
 *   symptom was beats off by one — beat 2 reporting `expected
 *   "/projects/gitpulse", got "/projects"` and beat 3 the exact inverse — which
 *   reads like a routing defect and is a TypeError.
 *
 * `new URL(url, base)` had accepted that object happily for as long as this
 * function has existed, because URL's constructor stringifies. The object-vs-
 * string distinction only became visible when a STRING METHOD was applied to
 * the argument. It cost a $0 CI run to find and would have cost a funded one.
 *
 * So the two outcomes are separated here: "the URL never matched" returns null
 * and the caller reports it in the beat's own terms, exactly as before; "the
 * predicate blew up" comes back as an Error and the caller reds LOUDLY, because
 * a runner defect must never be renderable as a fact about the page.
 */
async function waitForRoute(page, target, timeout) {
  let threw = null;
  await page
    .waitForURL(
      (u) => {
        try {
          return routeMatches(u, target);
        } catch (e) {
          threw ??= e;
          return false;
        }
      },
      { timeout },
    )
    .catch(() => {
      /* did not navigate — the caller reports that honestly */
    });
  return threw;
}

/** The verdict a predicate failure earns: named as the runner's own defect. */
function predicateFailure(target, err) {
  return (
    `the route predicate threw while waiting for "${target}": ${err?.message ?? String(err)}. ` +
    'That is a defect in the RUNNER, not a fact about the page — no arrival wait happened, so ' +
    'anything read after this point is the page before the navigation, not after it.'
  );
}

export async function driveBeat(page, rawBeat, index, baseUrl, bindings = {}, timeoutMs = READY_TIMEOUT_MS, agentProcProbe = null, stallDoor = null) {
  const { route: target, unbound } = resolveBeatRoute(rawBeat, bindings);
  if (unbound !== null) {
    return Object.freeze({
      act: rawBeat.act,
      say: rawBeat.say,
      status: 'red',
      failures: Object.freeze([
        `route "${rawBeat.expect.route}" needs <${unbound}>, which no earlier beat bound. ` +
          'A beat binds a segment by expecting `<name>` for a data-* key the product mints.',
      ]),
      bindings: Object.freeze({}),
      data: {},
    });
  }
  const beat = Object.freeze({ ...rawBeat, expect: Object.freeze({ ...rawBeat.expect, route: target }) });
  const steps = beat.do ?? [];
  // `6.11.10`: one bound per beat, resolved once, used by every wait this call
  // makes — the step waits, the consequence wait and the ready wait alike. A
  // beat that declared an agent-scale wait and still reds must SAY which bound
  // gave up, or "red at 15 s" and "red at ten minutes" read identically in a
  // run record.
  const bound = beatBound(rawBeat, timeoutMs);
  // What ENDED the wait, so the verdict can say it. `null` = the bound did.
  let stalled = null;
  // Bead `forge-8vfn.6.11.19` (T1 ruling 254). Did a waiter that can actually
  // OBSERVE the agent take this beat's declared bound? The URL wait and the
  // page-ready wait both consume it and neither watches an agent — which is
  // precisely how `6.11.17` hid — so neither sets this.
  let agentWaitConsumed = false;
  const named = (verdict) => {
    if (verdict.status !== 'red') return verdict;
    const why =
      stalled !== null
        ? `${stalled.why} ${Math.round(stalled.afterMs / 1000)}s into the ` +
          `${bound.label} — the product had already said so about this session, so the beat stopped there instead ` +
          'of sitting out its declared bound'
        : bound.label === null
          ? null
          : `gave up at the ${bound.label}`;
    return why === null ? verdict : Object.freeze({ ...verdict, failures: Object.freeze([...verdict.failures, why]) });
  };

  if (index === 0) {
    await page.goto(baseUrl + target, { waitUntil: 'domcontentloaded' });
  }

  // What the operator DOES, on the page they are standing on — the previous
  // beat's page — before this beat's state is judged. All nine operator flows
  // are form-driven, and until this existed the runner could only follow
  // links, so a story stopped dead at the first form.
  // `{ repeat: [...] }`'s stop condition IS the beat's own expectation — the
  // loop invents nothing to reach and nothing to bound itself by (§3.1,
  // rulings 312/317). Built here because this is where `beat` lives; only the
  // repeat branch ever calls it, so a beat without one pays no DOM read.
  const matchesData = async (spec) => {
    // `readObserved` runs `page.evaluate`, which THROWS when the page navigates
    // under it ("Execution context was destroyed"). A repeat polls this between
    // acts that submit and re-render, so it will meet that race — and an
    // unguarded throw here aborts the WHOLE run and drops every later story's
    // doc and gallery row, which is the same reason the click below is wrapped.
    // A read that could not happen is simply "not satisfied yet": the next poll
    // reads the settled page, and the beat's own bound still governs.
    try {
      // The matcher DECLARES the keys it needs (`6.11.45`). `spec` is the
      // repeat's `until`, whose keys the beat need not mention at all.
      const seen = resolveExpectations(spec, await readObserved(page, beat, Object.keys(spec)));
      return Object.entries(spec).every(
        ([attr, want]) => Object.hasOwn(seen, attr) && answers(seen[attr], want),
      );
    } catch {
      return false;
    }
  };
  // Bead `forge-8vfn.6.11.47` (ruling 366) — WHICH session this beat's waits
  // may be stopped by, and `null` when the beat names none. A beat standing on
  // a project page cannot be ended by a session's terminal phase, however
  // recently it left one: S1 run 10 beat 9 died `0s in` on the demo session
  // beat 8 had just failed, read during the commit window.
  const sessionScope = bound.label !== null && target.startsWith('/sessions/') ? target : null;
  const steps_ = await performSteps(page, steps, bound.ms, sessionScope, agentProcProbe, matchesData, null, target, stallDoor);
  const stepError = steps_.error;
  if (steps_.waitedForHandle) agentWaitConsumed = true;
  if (stepError !== null) {
    return withAgentProc(stuckVerdict(beat, await readObserved(page, beat), stepError), agentProcProbe);
  }

  // A press that saves asynchronously mints its route a moment later, so a beat
  // that ACTED waits for that route before anything below reads where it is.
  //
  // It waits on the URL and NOTHING ELSE. The shipped wait raced this against
  // "a link to the target became visible", and on every beat whose pressed
  // control IS that link — `new-agent`, `new-skill`, `new-hook`, `new-kb`,
  // `create-project-cta` — the link was already visible ON THE PAGE BEING
  // NAVIGATED AWAY FROM. `Promise.any` resolved instantly, `page.url()` still
  // read the SOURCE route because Next commits a client-side navigation after
  // its transition, and the block below clicked the same link a second time
  // into a detaching DOM. Two faces, one cause: a double click that reds
  // `could not click through to "/agents/new" from "/agents/new"` (S5 beat 2),
  // and a false `no real-nav path to "/skills/new" from "/skills/new"` where
  // the destination carries no link to itself (S7 beats 2 and 6). Both name the
  // same route as source and target, which is the tell. Bead `forge-8vfn.2.28`.
  //
  // A WAIT THE STATE IT IS LEAVING CAN SATISFY IS NOT A WAIT — the class M1-G
  // and M1-B closed one layer up, where `data-page-ready` could not tell
  // "not yet" from "already done" either. The URL can: it is the one signal
  // the source page cannot answer for the destination.
  //
  // But a same-route act has no URL to wait on at all, and the shipped code
  // treated that as nothing to wait FOR — the `steps.length > 0` guard above
  // fires only when the pathname already changed. A press that acts on the
  // route it is already standing on (an agent-dispatch button, a save that
  // stays put) still has a consequence: the state this beat asserts. Bead
  // `forge-8vfn.2.25`, measured live on S3 beat 11: pressing "Run onboarding
  // agent" started a real Claude process, and the same-tick read reported
  // `data-onboard-run-status="idle"` with no session id — the product had
  // already answered; the runner had not looked again. A story can spend
  // real money and still report the product never started.
  // A beat WATCHES as well as acts. `waitForConsequence` used to run only for a
  // beat with a `do` block, so a beat that merely observes an agent it did not
  // start — S1 beat 6, onboarding, which is fire-and-forget and has nothing to
  // press — declared a bound that bounded NOTHING. `6.11.19`'s guard said so in
  // its own words, on the first beat that exercised the case: the guard was
  // right and this wiring was the gap. A declared agent wait is a statement
  // about the BEAT (bead `forge-8vfn.6.11.25`, ruling 285).
  // T1 ruling 438 — A BEAT THAT MINTS A VALUE ALWAYS WAITS.
  //
  // MEASURED, S2 beat 10 in M5: no `do` that navigates and no declared `wait`,
  // so this condition was false and the page was read ONCE. A binding attribute
  // that is always PRESENT reads `""` on that read — before the mint returns —
  // and the beat reds with `got ""`. Bead `forge-8vfn.6.11.5` answered that in
  // the PRODUCT, by making the attribute absent until it has a value: a defect
  // that lives HERE, fixed in `apps/studio`, leaving every future always-present
  // binding attribute to fail the same way.
  //
  // A mint is asynchronous by definition, so a beat that expects one is a beat
  // that is waiting whether or not it declared a bound. The wait terminates:
  // `answers()` already treats `""` as not-yet (`beats-page.mjs:29`), so it ends
  // when the value arrives or at the beat's own bound, with the key named.
  const mints = Object.values(beat.expect.data).some((want) => PLACEHOLDER.test(want));
  if (steps.length > 0 || bound.label !== null || mints) {
    const waitedFrom = Date.now();
    if (steps.length > 0 && !routeMatches(page.url(), target)) {
      const threw = await waitForRoute(page, target, bound.ms);
      if (threw !== null) {
        return withAgentProc(
          stuckVerdict(beat, await readObserved(page, beat), predicateFailure(target, threw)),
          agentProcProbe,
        );
      }
    }
    // Bead `forge-8vfn.6.11.17`. The consequence wait used to run on the
    // same-route branch ALONE, so a beat whose press NAVIGATES got a wait on
    // the URL and nothing else — and a URL commits in about a second. S4 beat
    // 11 is that shape (`press: open-session` → `/sessions/architect/<id>`):
    // it declared `wait: { for: 'agent', upTo: 600_000 }`, bounded a route
    // change with it, read the session's phase immediately, and the verdict
    // then said `gave up at the agent wait (declared 600000 ms)` — naming a
    // bound that never fired. Declared, surfaced, enforced nowhere, in the very
    // field `6.11.10` added to stop a wrong bound. The route change is now just
    // the first part of the wait; the rest of the bound goes where it was
    // declared to go, on the state the beat is actually waiting for.
    if (routeMatches(page.url(), target)) {
      const left = bound.ms - (Date.now() - waitedFrom);
      if (left > 0) {
        stalled = await waitForConsequence(page, beat, left, sessionScope, agentProcProbe);
        agentWaitConsumed = true;
      }
    }
  }

  // Already there: the operator acted on this page and stayed on it, or the
  // press navigated. There is nothing to navigate TO. Real-nav-only is about
  // reaching a DIFFERENT route; a form-driven flow dwells on one route across
  // several operator actions, and the shipped runner called that unreachable.
  if (!routeMatches(page.url(), target)) {
    // QUERY-BLIND BY PATHNAME (bead `forge-8vfn.7.5.3`, T1 ruling 451).
    //
    // The runner READ a URL query-blind — `readObserved` compares
    // `new URL(page.url()).pathname` — and SELECTED a link query-strict, with an
    // exact `[href="<route>"]`. So it accepted arriving at a URL it refused to
    // find the link to, and the failure read "no link points at it" while the
    // anchor was on the page. Three LIVE product sites mount `SessionMinted`
    // with a `project`, so their hrefs carry `?project=…`:
    // `DemoStageHandoff.tsx:60`, `DemoTimeline.tsx:215`,
    // `ContractResolutionPanel.tsx:295` — the whole demo path.
    //
    // Site-by-site query dropping was REFUSED: a link that legitimately needs a
    // parameter must stay reachable, and a story declares the route an operator
    // would say out loud, not the product's parameter plumbing.
    //
    // The href is resolved against a base so a relative one normalises the same
    // way the browser resolves it; an href that will not parse is skipped rather
    // than guessed at.
    //
    // THE FILTER RUNS HERE, NOT IN THE PAGE — T1 ruling 527. It used to be a
    // hand-inlined copy of `routeMatches` inside the `evaluateAll` callback,
    // because that callback is serialised and executed IN THE BROWSER and
    // cannot close over a Node-side function. Two copies of a predicate whose
    // whole purpose is that there is only one of it: the browser callback now
    // just READS the hrefs, and the one predicate judges them on this side. An
    // href that will not parse is skipped by `routeMatches` itself rather than
    // guessed at.
    const all = await page
      .locator('[data-nav][href], a[href]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')).filter((h) => h !== null && h !== ''));
    // Collapse by DESTINATION, not by string. `routeMatches` chose these and is
    // fragment-blind (546); deduping on the raw href is blind to nothing, so the
    // two steps disagreed and the disagreement surfaced as a refusal — S10 run
    // 5's beat 6, where `/projects/gitpulse` and `/projects/gitpulse#roadmap`
    // were reported as two destinations "differing only in their query".
    // A fragment-free href is preferred within a group so the captured frame
    // shows the plain route; either member lands on the same page.
    const byDestination = new Map();
    for (const h of all.filter((h) => routeMatches(h, target))) {
      const key = destinationKey(h);
      if (key === null) continue;
      const held = byDestination.get(key);
      if (held === undefined || (held.includes('#') && !h.includes('#'))) byDestination.set(key, h);
    }
    const distinct = [...byDestination.values()];

    if (distinct.length > 1) {
      // NAMED, never picked. Two links whose pathnames match and whose queries
      // differ are two different destinations, and choosing one by DOM order is
      // how a beat silently starts asserting the wrong page (the same shape as
      // `resolveExpectations`' best-match tie-break).
      const observed = await readObserved(page, beat);
      return stuckVerdict(
        beat,
        observed,
        `ambiguous real-nav path to "${target}" from "${observed.route}": ${distinct.length} links share ` +
          `that pathname and differ in their QUERY, which makes them different destinations — ` +
          `${distinct.join(' , ')}. The runner will not pick ` +
          'one; name the destination the beat means, or give the page one link for it.',
      );
    }

    const href = distinct[0] ?? null;
    const nav = href === null ? null : page.locator(`[data-nav][href="${href}"]`).first();
    const link = href === null ? null : page.locator(`a[href="${href}"]`).first();
    const clickable =
      nav !== null && (await nav.count()) > 0 ? nav : link !== null && (await link.count()) > 0 ? link : null;

    if (clickable === null) {
      const observed = await readObserved(page, beat);
      return stuckVerdict(
        beat,
        observed,
        `no real-nav path to "${target}" from "${observed.route}": no [data-nav] pillar and no ` +
          'link whose PATHNAME is that route (a query string does not disqualify one). The runner ' +
          'does not fall back to page.goto — an unreachable route must not pass as a beat.',
      );
    }
    // Wait for the NEW route, not merely for "a ready page". The page we
    // clicked FROM is already `data-page-ready="true"`, so waiting on that
    // selector alone returns instantly against the old DOM. Measured on the
    // smoke story's first real run: beat 2 reported route "/" and
    // `data-page: "home"` because the assertion won the race with the
    // navigation — a false RED, and in the mirror case it would be a false
    // GREEN for any beat whose expectations the previous page happens to
    // satisfy.
    // The click itself is guarded. An obscured or non-actionable control (a
    // leftover modal, toast or backdrop from the previous beat) makes
    // playwright throw, and an unguarded throw here propagates past the beat
    // loop and aborts the WHOLE run — dropping every later story's doc and
    // gallery row, with a raw stack trace instead of an attributable verdict.
    // Found by adversarial review, reproduced with a full-viewport overlay
    // over a real [data-nav] link.
    let clickError = null;
    let navThrew = null;
    await Promise.all([
      waitForRoute(page, target, READY_TIMEOUT_MS).then((e) => { navThrew = e; }),
      clickable.click().catch((e) => {
        clickError = e?.message ?? String(e);
      }),
    ]);
    if (navThrew !== null) {
      return stuckVerdict(beat, await readObserved(page, beat), predicateFailure(target, navThrew));
    }

    if (clickError !== null) {
      const observed = await readObserved(page, beat);
      return stuckVerdict(
        beat,
        observed,
        `could not click through to "${target}" from "${observed.route}": ${clickError}. ` +
          'The control exists but was not actionable — obscured, disabled or detached.',
      );
    }
  }

  await page
    .waitForSelector('main[data-page][data-page-ready="true"]', { timeout: bound.ms })
    .catch(() => {
      /* not ready — the verdict below reports that honestly rather than throwing */
    });

  let verdict = named(beatVerdict(beat, await readObserved(page, beat), { boundMs: bound.ms, bound: bindings }));
  verdict = withAgentProc(verdict, agentProcProbe);
  // Bead `forge-8vfn.6.11.19` (T1 ruling 254) — the class, closed rather than
  // patched a fourth time. Fires WHATEVER the verdict would have been: a beat
  // that passes without its declared wait ever running passed by luck, and a
  // gate that accepts luck is the fail-open shape this campaign keeps paying
  // for. `6.11.17` was exactly that — a ten-minute bound spent on a URL change,
  // and a verdict that then named the bound as though it had fired.
  if (bound.label === null || agentWaitConsumed) return verdict;
  return Object.freeze({
    ...verdict,
    status: 'red',
    failures: Object.freeze([
      ...verdict.failures,
      `this beat declared ${JSON.stringify(rawBeat.wait)} and NO WAITER CONSUMED IT — the ${bound.ms} ms bound ` +
        'bounded nothing on this path. A URL wait and a page-ready wait both take the bound and neither watches ' +
        'an agent, so neither counts. Give the beat a `do` block or expectations a waiter can observe, or drop ' +
        'the declaration: a bound that bounds nothing makes every later verdict about it a lie.',
    ]),
  });
}

/**
 * Perform a beat's `do` steps, in order, on the page as it stands.
 *
 * A step names a `data-field` or `data-action` VALUE — forge-ui's own declared
 * contract, the same vocabulary `expect.data` reads — never a CSS selector: a
 * story that names markup is coupled to markup, which §3.1 avoids on purpose.
 *
 * Returns the failure text, or null. Every playwright throw is caught for the
 * reason the click below is: an unguarded throw aborts the WHOLE run and drops
 * every later story's doc and gallery row.
 *
 * Steps ran back-to-back with no wait between them. A step that navigates —
 * a shelf CTA, a create button, any press — starts a client-side route
 * change, and the very next step resolved its handle against the OLD page,
 * which does not carry it. Bead `forge-8vfn.2.29`, measured on S7's template
 * beat: do = [press new-template, fill template-category, ...] failed with
 * "could not fill [data-field="template-category"]: Timeout 5000ms exceeded"
 * because the press had navigated /library -> /templates/new and the fill
 * ran before the new page mounted. So from the SECOND step on, this waits —
 * bounded, and only after the first step, matching the original zero-wait
 * behaviour for a single-step `do` block exactly — for the arrival page's
 * ready signal, then for the next handle itself, rather than reading
 * whatever the previous step left in the DOM in the same tick. That is what
 * lets a story express "press the create CTA and fill in the form it opens"
 * as ONE beat instead of splitting one operator act across two.
 */
/**
 * Test seam for `{ repeat: [...] }` (§3.1). `performSteps` is the whole
 * behaviour under test and driving it through a real browser would test
 * playwright, not the loop — so the loop is exercised against a fake page that
 * models the ONE thing that matters: the product decides when to stop.
 */
