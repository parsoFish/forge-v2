import { PLACEHOLDER, resolveExpectations, ERROR_SENTINELS, routeMatches } from './beats-page.mjs';

/**
 * beats.mjs — judging one story beat.
 *
 * `beatVerdict` is PURE and lives apart from any browser I/O, so every rule
 * about what makes a beat red is unit-testable without booting Studio. That
 * separation is the point: the old harness could only be trusted by running
 * it.
 *
 * The rule the whole module exists to enforce: **a beat is judged against the
 * expectations it DECLARED, never against the state that happened to be
 * there.** Iterating observed state instead of expected state is the
 * fail-open shape — it reports green for a page that rendered nothing.
 */



/**
 * Judge one beat against what was observed on the page.
 *
 * @param {{act: string, say: string, expect: {route: string, data: Record<string,string>}}} beat
 * @param {{route: string, data: Record<string,string>, nested?: readonly Record<string,string>[]}} observed
 * @returns {Readonly<{act: string, say: string, status: 'green'|'red', failures: readonly string[], bindings: Readonly<Record<string,string>>}>}
 */
export function beatVerdict(beat, observed, { boundMs = null, bound = {} } = {}) {
  const failures = [];
  const bindings = {};

  // THROUGH `routeMatches`, never `!==` — T1 ruling 527, bought by the aborted
  // G1/S10 run. Ruling 514 made `observed.route` carry the query; this compare
  // stayed a string equality, so every beat standing on a page the product
  // mounts with `?project=` reded ON ARRIVAL. S10 beat 2 declared
  // `/architect/new`, the product served `/architect/new?project=gitpulse`, and
  // the run died at 36 s on the harness rather than on anything it was
  // measuring. 514 replaced five hand-rolled compares and 518 a sixth; this one
  // — the compare that WRITES THE VERDICT — survived both.
  // `beats-route-verdict.test.ts` now refuses any `===`/`!==` between two routes
  // anywhere under `scripts/stories/`, because the rule was carried in prose for
  // two PRs and prose does not grep.
  if (!routeMatches(observed.route, beat.expect.route)) {
    failures.push(`route: expected "${beat.expect.route}", got "${observed.route}"`);
  }

  const seen = resolveExpectations(beat.expect.data, observed);

  // Iterate the EXPECTED keys. Never the observed ones — an attribute the UI
  // never rendered must be a failure, not an absence nobody looked for.
  for (const [attr, want] of Object.entries(beat.expect.data)) {
    if (!Object.hasOwn(seen, attr)) {
      failures.push(`data-${attr}: expected "${want}", absent from the page`);
      continue;
    }
    const got = seen[attr];
    const placeholder = PLACEHOLDER.exec(want);
    if (placeholder !== null) {
      // A value the product mints at runtime. Any value binds; the empty
      // string is a product that minted nothing, and binding it would put an
      // empty segment in a later beat's route.
      // T1 ruling 438. `""` on a binding attribute is not "the wrong value" —
      // it is a mint that has not returned, and the runner has now WAITED for
      // it (see `driveBeat`). So the failure names what actually happened and
      // the bound it happened within, rather than a bare `got ""` that reads
      // like a product returning the empty string on purpose.
      if (got === '') {
        failures.push(
          boundMs === null
            ? `data-${attr}: expected a value to bind as ${want}, got ""`
            : `data-${attr}: expected a value to bind as ${want}, but the product minted nothing within ${boundMs} ms`,
        );
      }
      // COMPARE WHEN ALREADY BOUND — T1 ruling 585 (i). This was an
      // unconditional write, so a beat re-declaring a placeholder to RE-ASSERT
      // the value overwrote it and asserted nothing. A story that binds a value
      // in one beat and names it again in another is asserting a THIRD thing —
      // that the two places agree — and that is exactly the assertion that was
      // being discarded. S9 bought this: beat 8 bound `authoringCostUsd` 0.71
      // from the authoring session's own page, beat 15 rebound it to 0.39 from
      // `/monitor`, and the run reported a wrong-agent failure for what was a
      // missing row (`forge-b6af`).
      else if (Object.hasOwn(bound, placeholder[1]) && bound[placeholder[1]] !== got) {
        failures.push(
          `data-${attr}: expected "${bound[placeholder[1]]}" (bound as ${want} by an earlier beat), got "${got}"`,
        );
      }
      else bindings[placeholder[1]] = got;
      continue;
    }
    if (got !== want) {
      failures.push(`data-${attr}: expected "${want}", got "${got}"`);
    }
  }

  // SETTLED IS NOT SUCCEEDED. The product's convention is that a route whose
  // fetch THREW still renders its own `data-page` and `data-page-ready="true"`
  // — it HAS settled, into an honest failure — and reports it via
  // `data-fetch-status="error"` / `data-load-error="true"`
  // (`components/PageLoadError.tsx`; `ProjectsIndex.tsx`:
  // `error ? 'error' : ready ? 'ok' : 'loading'`).
  //
  // So a beat asserting only {page, page-ready} passes against a visibly
  // broken page. The runner judges these sentinels on EVERY beat rather than
  // trusting each story author to remember them — a rule that depends on nine
  // authors remembering is how this class survives. A story that deliberately
  // asserts an error surface simply declares it, and is honoured.
  for (const [attr, bad] of ERROR_SENTINELS) {
    if (observed.data[attr] !== bad) continue;
    if (beat.expect.data[attr] === bad) continue; // the story asked for it
    failures.push(
      `data-${attr} is "${bad}": the page settled into an error, so this beat cannot pass. ` +
        'Assert it deliberately if the story is about the failure surface.',
    );
  }

  return Object.freeze({
    act: beat.act,
    say: beat.say,
    status: failures.length === 0 ? 'green' : 'red',
    failures: Object.freeze(failures),
    bindings: Object.freeze(bindings),
    // What the beat was JUDGED against, root and nested alike. The how-to
    // fragment renders this as its "what you should see" list, so reporting
    // only the page root would let a beat assert `data-card-id="gitweave"`
    // while the generated documentation never mentions it — the tests, demos
    // and docs drifting apart inside the one script §3 built to stop that.
    data: Object.freeze({ ...observed.data, ...seen }),
  });
}

/**
 * The verdict for a beat that never reached its page — a `do` step that could
 * not act, no real-nav path, a control that was not actionable. All three
 * leave the browser on the PREVIOUS page, which is read so the failure can
 * name where it was stuck.
 *
 * It exports NO bindings. A `<name>` harvested from the wrong page would hand
 * a later beat a route segment that page happened to supply, and that beat
 * could go GREEN on it — the fail-open shape, reached through the new verb.
 */
export function stuckVerdict(beat, observed, failure) {
  return Object.freeze({
    ...beatVerdict(beat, observed),
    status: 'red',
    failures: Object.freeze([failure]),
    bindings: Object.freeze({}),
    data: observed.data,
  });
}





/**
 * Substitute the `<name>` segments of a beat's route from what earlier beats
 * bound. The pinned S1 already writes this convention: beat 4 declares
 * `'onboard-session-id': '<sessionId>'`, beats 5-6 route
 * `/sessions/onboarding/<sessionId>`.
 *
 * An unbound placeholder is NOT navigated to as a literal — that would 404 and
 * blame the product for a story-authoring gap.
 */
export function resolveBeatRoute(beat, bindings) {
  let unbound = null;
  const route = beat.expect.route.replace(/<([A-Za-z][A-Za-z0-9_]*)>/g, (whole, name) => {
    if (Object.hasOwn(bindings, name)) return bindings[name];
    unbound ??= name;
    return whole;
  });
  return { route, unbound };
}





/** How long to wait for a page to declare itself ready before judging it. */
export const READY_TIMEOUT_MS = 15_000;

/**
 * The bound this beat's waits get, and the NAME of the bound that fired.
 *
 * Bead `forge-8vfn.6.11.10` (T1 ruling 220). Three beats across three stories
 * — S1 beat 6 and S2 beat 12 (`session-answer` absent until the agent asks)
 * and S4 beat 11 (`session-phase` still `interviewing`) — were red not because
 * the product was wrong but because `READY_TIMEOUT_MS` was the runner's ONLY
 * bound, and fifteen seconds is right for a DOM update and absurd for an
 * architect's interview. Same family as `6.11.6`: the wait existed; the BOUND
 * was wrong for what it was waiting on.
 *
 * DECLARED, never inferred, and never global. Raising `READY_TIMEOUT_MS`
 * would make every genuine product red take fifteen times longer to fail, so
 * a beat that stands on an agent says so — `wait: { for: 'agent', upTo: <ms> }`
 * — and only that beat waits longer. §3.1 states it so no story has to read
 * this file to learn it.
 */
export function beatBound(beat, domTimeoutMs) {
  const declared = beat.wait;
  if (declared === undefined || declared === null) return { ms: domTimeoutMs, label: null };
  return { ms: declared.upTo, label: `agent wait (declared ${declared.upTo} ms)` };
}





/**
 * Append what the agent's own process was doing, to a RED verdict ONLY.
 *
 * Bead `forge-8vfn.6.11.22`. `6.11.17` is P1, open, owner unknown and
 * INTERMITTENT — S4 run 2 hung while an out-of-story dispatch and S2 run 3's
 * architect both completed — so the next occurrence has to describe itself
 * rather than be reconstructed from an archive by hand afterwards.
 *
 * A GREEN beat carries no diagnosis: nobody needs it, and the generated how-to
 * renders a beat's failures, so a trend on a passing beat would become
 * documentation of nothing.
 */
export function withAgentProc(verdict, probe) {
  if (verdict.status !== 'red' || probe === null || typeof probe?.summary !== 'function') return verdict;
  let trend = null;
  try {
    trend = probe.summary();
  } catch {
    return verdict; // diagnosis is never load-bearing
  }
  if (trend === null || trend === undefined || trend === '') return verdict;
  return Object.freeze({ ...verdict, failures: Object.freeze([...verdict.failures, trend]) });
}

/**
 * Reach the beat's route by REAL NAVIGATION and read what the page shows.
 *
 * `page.goto` is used for the FIRST beat only — the operator opening Studio.
 * Every later beat must get there the way an operator does, by clicking a real
 * control: a story that teleports between routes proves each route renders but
 * never proves you can get from one to the next.
 *
 * The story contract (§3.1) gives prose in `act` and a route in
 * `expect.route`, and no selector. So the runner resolves the click from the
 * route itself — the nav pillar pointing at it, else any link to it. When
 * neither exists the beat is RED saying so; it never falls back to
 * `page.goto`, which would let an unreachable route pass.
 *
 * `timeoutMs` bounds every wait this call makes (`run.mjs` never passes it,
 * so production always gets `READY_TIMEOUT_MS`); it exists so a test can
 * prove a wait gives up at its bound without the suite actually sitting
 * through 15 real seconds to do it.
 */
