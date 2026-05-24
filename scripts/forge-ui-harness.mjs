#!/usr/bin/env node
/**
 * forge-ui-harness — scenario-based end-to-end harness driving synthetic
 * cycle state through `forge watch` and asserting via DOM-as-metrics +
 * bridge HTTP responses. The scenarios mirror the betterado-style
 * failure modes the 2026-05-23 dogfood surfaced; if any of them
 * regresses, this script exits non-zero.
 *
 *   S1  happy-path-ui-flow                  pending → in-flight →
 *                                           ready-for-review → done; assert
 *                                           data-active-cycle-status flips
 *                                           through every state.
 *   S2  failed-unifier-cycle                appends a reviewer.pr-open-failed
 *                                           event; asserts the cycle tab
 *                                           tags it failed (NOT ready-for-
 *                                           review — the F1.I1 regression).
 *   S3  cost-rollup                         appends events with cost
 *                                           metadata; asserts bridge
 *                                           /api/cost returns totalUsd > 0
 *                                           and the UI shows it on the hex
 *                                           canvas (data-phase-cost-usd) +
 *                                           page header
 *                                           (data-active-cycle-cost-usd).
 *   S4  ui-components-render                asserts the three new components
 *                                           (agent-hex-canvas, wi-graph,
 *                                           activity-panel) reach a non-
 *                                           loading state with the seeded
 *                                           cycle.
 *   S5  send-back-cli                       runs `forge send-back` against a
 *                                           synthetic ready-for-review;
 *                                           asserts the verdict-response.md
 *                                           was written with parsed ACs.
 *   S6  requeue-cli                         runs `forge requeue` against a
 *                                           synthetic failed cycle; asserts
 *                                           the manifest moved to pending/.
 *
 * Usage:
 *   node scripts/forge-ui-harness.mjs              # run all scenarios headless
 *   node scripts/forge-ui-harness.mjs --only S3    # run a single scenario
 *   node scripts/forge-ui-harness.mjs --keep-going # don't bail on first fail
 *   node scripts/forge-ui-harness.mjs --showcase   # operator-watchable mode:
 *                                                  # no headless chromium,
 *                                                  # operator opens browser
 *                                                  # at http://localhost:4124,
 *                                                  # each scenario narrates +
 *                                                  # pauses 4s between steps
 *                                                  # so the UI's reaction
 *                                                  # is visible in real time.
 *
 * Exits 0 if every scenario passes, 1 otherwise.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FORGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = {
  only: arg('--only'),
  keepGoing: args.includes('--keep-going'),
  showcase: args.includes('--showcase'),
};
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Inter-step pause in showcase mode (ms). Long enough for a human to
// see the UI react; short enough that the full suite finishes in ~1min.
const SHOWCASE_PAUSE_MS = 4000;

// ---- shared infra --------------------------------------------------------

function log(scen, msg) {
  console.log(`[harness:${scen}] ${msg}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn `forge watch --no-open` in its own process group. Returns once the
 * UI is ready (Next.js logs "Ready in"). Reuses the discovered ui/bridge
 * URLs across all scenarios in a run.
 */
async function startWatch() {
  return new Promise((res, rej) => {
    const proc = spawn(
      process.execPath,
      ['--experimental-strip-types', 'orchestrator/cli.ts', 'watch', '--no-open'],
      { cwd: FORGE_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let uiUrl = null;
    let bridgeUrl = null;
    const onData = (chunk) => {
      const text = chunk.toString();
      const uiMatch = text.match(/http:\/\/localhost:\d+/);
      const bridgeMatch = text.match(/bridge at (http:\/\/127\.0\.0\.1:\d+)/);
      if (bridgeMatch && !bridgeUrl) bridgeUrl = bridgeMatch[1];
      if (uiMatch && !uiUrl) uiUrl = uiMatch[0];
      if (text.includes('Ready in') && uiUrl && bridgeUrl) res({ proc, uiUrl, bridgeUrl });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', rej);
    setTimeout(() => {
      if (!uiUrl || !bridgeUrl) rej(new Error('forge watch did not become ready within 30s'));
    }, 30000);
  });
}

function stopWatch(proc) {
  return new Promise((res) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; res(); };
    proc.on('exit', done);
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* */ }
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* */ } done(); }, 3000);
  });
}

/**
 * Build a unique initiative id + matching cycle id + log dir for a
 * scenario. Each call gives a fresh INIT-* so scenarios don't collide.
 * The log dir + an initial cycle.queued event are seeded immediately so
 * the bridge picks the cycle up regardless of which queue it lives in.
 */
function newCycle(scen) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
  const date = stamp.slice(0, 10);                          // YYYY-MM-DD
  const tag = Math.random().toString(36).slice(2, 6);       // 4-char alphanum
  // Canonical initiative-id shape: INIT-YYYY-MM-DD-<slug>
  // (orchestrator/initiative-id.ts:CANONICAL_PATTERN).
  const initiativeId = `INIT-${date}-harness-${scen.toLowerCase()}-${tag}`;
  const cycleId = `${stamp}_${initiativeId}`;
  const logDir = resolve(FORGE_ROOT, '_logs', cycleId);
  const cycle = { initiativeId, cycleId, logDir };
  appendEvent(cycle, 'orchestrator', 'log', 'cycle.queued (harness seed)');
  return cycle;
}

const QDIR = (name) => resolve(FORGE_ROOT, '_queue', name);

function manifestPath(queue, initiativeId) {
  return join(QDIR(queue), `${initiativeId}.md`);
}

function writeManifest(queue, initiativeId, project = 'harness') {
  mkdirSync(QDIR(queue), { recursive: true });
  // Schema: orchestrator/manifest.ts:parseManifest requires
  //   initiative_id, project, created_at, iteration_budget, cost_budget_usd.
  // features use feature_id / title (not id / name).
  const body = `---
initiative_id: ${initiativeId}
project: ${project}
project_repo_path: /tmp/harness-nonexistent-repo
created_at: '${new Date().toISOString()}'
iteration_budget: 5
cost_budget_usd: 1.0
features:
  - feature_id: FEAT-1
    title: harness scenario
    depends_on: []
---

# Harness scenario

Synthetic manifest authored by scripts/forge-ui-harness.mjs.
`;
  // Atomic write so the bridge's fs.watch fires on a complete file.
  const dest = manifestPath(queue, initiativeId);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, body);
  renameSync(tmp, dest);
}

function moveManifest(fromQueue, toQueue, initiativeId) {
  mkdirSync(QDIR(toQueue), { recursive: true });
  renameSync(manifestPath(fromQueue, initiativeId), manifestPath(toQueue, initiativeId));
}

/**
 * Append a JSONL event. `extras` is merged at the top level — that's
 * where cli/metrics.ts looks for cost_usd / tokens_in / tokens_out /
 * duration_ms. Anything else (work_item_id, missing, …) belongs in
 * `metadata`.
 */
function appendEvent(cycle, phase, eventType, message, opts = {}) {
  const { metadata = {}, ...extras } = opts;
  mkdirSync(cycle.logDir, { recursive: true });
  const entry = {
    event_id: `EV_${Math.random().toString(36).slice(2, 10)}`,
    cycle_id: cycle.cycleId,
    initiative_id: cycle.initiativeId,
    started_at: new Date().toISOString(),
    phase,
    skill: phase,
    event_type: eventType,
    input_refs: [],
    output_refs: [],
    message,
    metadata,
    ...extras,
  };
  appendFileSync(join(cycle.logDir, 'events.jsonl'), JSON.stringify(entry) + '\n');
}

function cleanupCycle(cycle) {
  for (const q of ['pending', 'in-flight', 'ready-for-review', 'done', 'failed']) {
    try { rmSync(manifestPath(q, cycle.initiativeId), { force: true }); } catch { /* */ }
    try { rmSync(join(QDIR(q), `${cycle.initiativeId}.verdict-response.md`), { force: true }); } catch { /* */ }
    try { rmSync(join(QDIR(q), `${cycle.initiativeId}.verdict-prompt.md`), { force: true }); } catch { /* */ }
  }
  try { rmSync(cycle.logDir, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Navigate the page to the seeded cycle and wait until the UI fully
 * settles on it (data-active-cycle-id + WS reports open). In showcase
 * mode (page === null) skip the click and instead poll the bridge until
 * the cycle is visible — the operator's browser will auto-select the
 * most recent live cycle, which is the one we just seeded.
 */
async function focusCycle(page, ui, cycle, timeoutMs = 15000) {
  if (!page) {
    // Showcase: wait until the bridge lists this cycle, then pause so the
    // operator's browser has time to render the new tab + flip its
    // default selection to it.
    await waitForBridgeCycle(ui, cycle.cycleId, timeoutMs);
    await narrate(`        ↳ cycle now visible at ${ui.uiUrl} (auto-selected as the most recent live)`);
    await sleep(SHOWCASE_PAUSE_MS);
    return;
  }
  await page.goto(ui.uiUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('main')?.getAttribute('data-page-ready') === 'true',
    undefined,
    { timeout: timeoutMs },
  );
  // Click the cycle tab. If it isn't there yet, the bridge hasn't seen
  // the manifest — wait briefly then retry.
  for (let i = 0; i < 10; i++) {
    const btn = page.locator(`[data-cycle-id="${cycle.cycleId}"]`).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      await page.waitForFunction(
        (id) => document.querySelector('main')?.getAttribute('data-active-cycle-id') === id,
        cycle.cycleId,
        { timeout: 5000 },
      );
      return;
    }
    await sleep(500);
  }
  throw new Error(`cycle button [data-cycle-id="${cycle.cycleId}"] never appeared`);
}

/**
 * Showcase-mode narration: prints to stdout in a chatty format the
 * operator can follow live alongside their browser.
 */
async function narrate(msg) {
  if (!flags.showcase) return;
  console.log(`        ${msg}`);
}

/**
 * Poll the bridge's /api/cycles until the given cycleId appears (or the
 * timeout fires). Used by showcase mode in lieu of DOM polling.
 */
async function waitForBridgeCycle(ui, cycleId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ui.bridgeUrl}/api/cycles`);
      if (res.ok) {
        const body = await res.json();
        const all = [...(body.live ?? []), ...(body.recent ?? [])];
        if (all.some((c) => c.cycleId === cycleId)) return;
      }
    } catch { /* bridge still warming up */ }
    await sleep(500);
  }
  throw new Error(`bridge /api/cycles never listed ${cycleId} within ${timeoutMs}ms`);
}

/**
 * Poll the bridge until the cycle reaches the expected status. Used by
 * showcase mode to confirm propagation before pausing for the operator.
 */
async function waitForBridgeStatus(ui, cycleId, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = '(none)';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ui.bridgeUrl}/api/cycles`);
      if (res.ok) {
        const body = await res.json();
        const all = [...(body.live ?? []), ...(body.recent ?? [])];
        const c = all.find((x) => x.cycleId === cycleId);
        if (c) {
          last = c.status;
          if (c.status === expected) return;
        }
      }
    } catch { /* try again */ }
    await sleep(500);
  }
  throw new Error(`bridge never showed ${cycleId} as ${expected} (last seen: ${last})`);
}

// ---- assertion helpers ---------------------------------------------------

function fail(scen, msg) {
  const err = new Error(`[harness:${scen}] FAIL: ${msg}`);
  err.scenario = scen;
  throw err;
}

async function expect(scen, page, fn, descr, timeoutMs = 10000) {
  // Showcase: no headless page — DOM-level checks are skipped. The
  // narration + the operator's own browser is the verification surface.
  if (!page) {
    await narrate(`(showcase: skipping DOM check "${descr}" — verify visually)`);
    return;
  }
  try {
    await page.waitForFunction(fn, undefined, { timeout: timeoutMs });
  } catch {
    const snapshot = await page.evaluate(() => document.querySelector('main')?.outerHTML?.slice(0, 500));
    fail(scen, `${descr}\n  main snapshot: ${snapshot}`);
  }
}

// ---- scenarios -----------------------------------------------------------

/**
 * S1 — happy path: pending → in-flight → ready-for-review → done. Assert
 * the cycle tab status flips at each step. Uses data-cycle-id="…"
 * data-cycle-status, set by the cycles tab in page.tsx.
 */
async function S1(ui, page) {
  const cycle = newCycle('S1');
  try {
    log('S1', `cycle=${cycle.cycleId}`);
    await narrate('Watch the cycles tab — a new "harness" cycle appears, then walks pending → in-flight → ready-for-review → done.');
    writeManifest('pending', cycle.initiativeId);
    await focusCycle(page, ui, cycle);
    await expectStatus('S1', page, cycle.cycleId, 'pending');
    log('S1', 'pending ✓');

    await narrate('Step: pending → in-flight. The state-machine row for "architect" should flip to active (▶).');
    moveManifest('pending', 'in-flight', cycle.initiativeId);
    appendEvent(cycle, 'architect', 'start', 'architect start');
    await expectStatus('S1', page, cycle.cycleId, 'in-flight');
    log('S1', 'in-flight ✓');

    await narrate('Step: in-flight → ready-for-review. Verdict form should appear; activity sidebar gains "developer-loop".');
    appendEvent(cycle, 'architect', 'end', 'architect end');
    appendEvent(cycle, 'developer-loop', 'start', 'dev start');
    appendEvent(cycle, 'developer-loop', 'end', 'dev end');
    moveManifest('in-flight', 'ready-for-review', cycle.initiativeId);
    await expectStatus('S1', page, cycle.cycleId, 'ready-for-review');
    log('S1', 'ready-for-review ✓');

    await narrate('Step: ready-for-review → done. Cycle moves out of "live", verdict form disappears, final toast fires.');
    moveManifest('ready-for-review', 'done', cycle.initiativeId);
    appendEvent(cycle, 'closure', 'end', 'merged');
    await expectStatus('S1', page, cycle.cycleId, 'done');
    log('S1', 'done ✓');
  } finally {
    cleanupCycle(cycle);
  }
}

async function expectStatus(scen, page, cycleId, status) {
  // Showcase: poll the bridge instead, then pause so the operator's
  // browser visibly transitions before the next step kicks off.
  if (!page) {
    // The `ui` object is captured in the showcase driver closure — fall
    // back to a global stash set in main() to keep this signature stable.
    const ui = globalShowcaseUi;
    try {
      await waitForBridgeStatus(ui, cycleId, status, 15000);
    } catch (err) {
      fail(scen, err.message);
    }
    await narrate(`        ↳ bridge confirms ${status}; pausing ${SHOWCASE_PAUSE_MS / 1000}s for the UI`);
    await sleep(SHOWCASE_PAUSE_MS);
    return;
  }
  try {
    await page.waitForFunction(
      ({ id, s }) => document.querySelector(`[data-cycle-id="${id}"]`)?.getAttribute('data-cycle-status') === s,
      { id: cycleId, s: status },
      { timeout: 10000 },
    );
  } catch {
    const actual = await page.evaluate(
      (id) => document.querySelector(`[data-cycle-id="${id}"]`)?.getAttribute('data-cycle-status'),
      cycleId,
    );
    fail(scen, `expected data-cycle-status="${status}" for ${cycleId}, got "${actual}"`);
  }
}

// Stashed in main() before scenarios run so showcase-mode helpers (which
// receive a null `page`) can still reach the bridge URL.
let globalShowcaseUi = null;

/**
 * S2 — failed-unifier cycle. Simulates the F1.I1 betterado regression:
 * cycle goes in-flight, emits reviewer.pr-open-failed, lands in failed/.
 * Assert the UI tags it failed (not ready-for-review).
 */
async function S2(ui, page) {
  const cycle = newCycle('S2');
  try {
    log('S2', `cycle=${cycle.cycleId}`);
    await narrate('This regression-tests the F1.I1 bug: a cycle whose unifier never opened a PR USED TO show as "ready-for-review" with no PR. Now it lands as "failed". Watch the cycle tab — the new cycle should appear with a ✗ glyph (failed), NOT ⏸ (ready-for-review).');
    writeManifest('in-flight', cycle.initiativeId);
    appendEvent(cycle, 'review-loop', 'start', 'review start');
    appendEvent(
      cycle,
      'review-loop',
      'log',
      'reviewer.pr-open-failed: PR was not opened (DEMO.md / pr-description.md missing)',
      { missing: ['demo/INIT/DEMO.md', '.forge/pr-description.md'] },
    );
    moveManifest('in-flight', 'failed', cycle.initiativeId);
    await focusCycle(page, ui, cycle);

    await expectStatus('S2', page, cycle.cycleId, 'failed');
    log('S2', 'failed ✓');

    // Negative check: must NOT be tagged ready-for-review (the regression).
    // The positive check above already confirms status=failed, but in
    // headless we double-check the DOM literal to guard against a
    // hypothetical regression that returns BOTH (which expectStatus would
    // tolerate). Showcase skips it since `page` is null.
    if (page) {
      const status = await page.evaluate(
        (id) => document.querySelector(`[data-cycle-id="${id}"]`)?.getAttribute('data-cycle-status'),
        cycle.cycleId,
      );
      if (status === 'ready-for-review') {
        fail('S2', `cycle ${cycle.cycleId} regressed to ready-for-review (the F1.I1 bug)`);
      }
    }
  } finally {
    cleanupCycle(cycle);
  }
}

/**
 * S3 — cost rollup. Seeds events with metadata.cost_usd at three phases.
 * Asserts (a) bridge /api/cost returns the expected totals and (b) the
 * UI's header badge + per-phase hex cost pills surface them via DOM.
 */
async function S3(ui, page) {
  const cycle = newCycle('S3');
  try {
    log('S3', `cycle=${cycle.cycleId}`);
    await narrate('Cost telemetry. Three phase-end events fire with cost metadata totalling $1.51. Watch: (a) the purple $1.51 badge in the page header, (b) the hex canvas should grow per-phase cost pills (architect $0.12, pm $0.34, dev $1.05).');
    writeManifest('in-flight', cycle.initiativeId);
    appendEvent(cycle, 'architect', 'end', 'architect end', { cost_usd: 0.12, duration_ms: 1000 });
    appendEvent(cycle, 'project-manager', 'end', 'pm end', { cost_usd: 0.34, duration_ms: 2000 });
    appendEvent(cycle, 'developer-loop', 'end', 'dev end', { cost_usd: 1.05, duration_ms: 5000 });

    // (a) bridge returns rolled-up cost
    const url = `${ui.bridgeUrl}/api/cost/${encodeURIComponent(cycle.cycleId)}`;
    const res = await fetch(url);
    if (!res.ok) fail('S3', `bridge ${url} returned ${res.status}`);
    const body = await res.json();
    const expectedTotal = 0.12 + 0.34 + 1.05;
    if (Math.abs(body.totalUsd - expectedTotal) > 0.001) {
      fail('S3', `bridge totalUsd=${body.totalUsd}, expected ${expectedTotal}`);
    }
    if (!body.perPhase || !body.perPhase['architect']) {
      fail('S3', `bridge perPhase missing 'architect': ${JSON.stringify(body.perPhase)}`);
    }
    log('S3', `bridge cost rollup ✓ ($${body.totalUsd.toFixed(2)})`);

    // (b) UI surfaces cost
    await focusCycle(page, ui, cycle);
    await expect(
      'S3',
      page,
      () => {
        const main = document.querySelector('main');
        const v = main?.getAttribute('data-active-cycle-cost-usd');
        return v && parseFloat(v) > 0;
      },
      'expected data-active-cycle-cost-usd > 0 on <main>',
    );
    const headerCost = page
      ? await page.evaluate(() => document.querySelector('main')?.getAttribute('data-active-cycle-cost-usd'))
      : '(showcase — verify visually)';
    log('S3', `UI header cost ✓ ($${headerCost})`);

    // hex per-phase pill: at least one phase shows data-phase-cost-usd
    await expect(
      'S3',
      page,
      () => {
        const pills = document.querySelectorAll('[data-phase-hex][data-phase-cost-usd]');
        for (const p of pills) {
          const c = parseFloat(p.getAttribute('data-phase-cost-usd') ?? '0');
          if (c > 0) return true;
        }
        return false;
      },
      'expected at least one [data-phase-hex] with data-phase-cost-usd > 0',
    );
    log('S3', 'hex cost pill ✓');
  } finally {
    cleanupCycle(cycle);
  }
}

/**
 * S4 — UI components render. Seeds a cycle with a mermaid WI graph and a
 * range of events. Asserts each of the three new components reaches a
 * non-loading state:
 *
 *   - AgentHexCanvas:    data-component="agent-hex-canvas"
 *   - WiGraphCanvas:     data-section="wi-graph" data-state="ready"
 *   - ActivityPanel:     data-component="activity-panel" data-events-shown >= 1
 */
async function S4(ui, page) {
  const cycle = newCycle('S4');
  try {
    log('S4', `cycle=${cycle.cycleId}`);
    await narrate('Three new UI components prove themselves: hex canvas with 6 phase hexes, WI dep-graph below it with WI-1 → WI-2 + WI-3, and the activity panel with chip filters. Try clicking WI-2 in the graph — the activity panel should auto-filter to that work item.');
    writeManifest('in-flight', cycle.initiativeId);
    appendEvent(cycle, 'architect', 'end', 'architect end', { cost_usd: 0.1 });
    appendEvent(cycle, 'project-manager', 'end', 'pm end', { cost_usd: 0.2 });
    appendEvent(cycle, 'developer-loop', 'start', 'dev start');
    appendEvent(cycle, 'developer-loop', 'iteration', 'WI-1 iter 1', { metadata: { work_item_id: 'WI-1' } });
    appendEvent(cycle, 'developer-loop', 'iteration', 'WI-2 iter 1', { metadata: { work_item_id: 'WI-2' } });

    // Synthetic mermaid graph so the WiGraphCanvas has something to layout.
    mkdirSync(join(cycle.logDir, 'work-items-snapshot'), { recursive: true });
    writeFileSync(
      join(cycle.logDir, 'work-items-snapshot', '_graph.md'),
      `# Work-item graph — ${cycle.initiativeId}\n\n` +
        '```mermaid\n' +
        'graph TD\n' +
        '    WI-1["WI-1: seed"]\n' +
        '    WI-2["WI-2: tests"]\n' +
        '    WI-3["WI-3: docs"]\n' +
        '\n' +
        '    WI-1 --> WI-2\n' +
        '    WI-1 --> WI-3\n' +
        '```\n',
    );

    await focusCycle(page, ui, cycle);

    // AgentHexCanvas: at least 6 phase hex mirror-divs.
    await expect(
      'S4',
      page,
      () => {
        const hexes = document.querySelectorAll('[data-phase-hex]');
        return hexes.length >= 6;
      },
      'expected >=6 [data-phase-hex] mirror divs from AgentHexCanvas',
    );
    log('S4', 'AgentHexCanvas ✓');

    // WiGraphCanvas: data-state should reach "ready".
    await expect(
      'S4',
      page,
      () => {
        const el = document.querySelector('[data-section="wi-graph"]');
        return el?.getAttribute('data-state') === 'ready';
      },
      'expected [data-section="wi-graph"][data-state="ready"]',
    );
    const wiCount = page
      ? await page.evaluate(() => document.querySelector('[data-section="wi-graph"]')?.getAttribute('data-wi-count'))
      : '(showcase — verify visually)';
    if (page && parseInt(wiCount ?? '0', 10) < 3) {
      fail('S4', `expected data-wi-count >= 3, got "${wiCount}"`);
    }
    log('S4', `WiGraphCanvas ✓ (wi-count=${wiCount})`);

    // ActivityPanel: events-shown > 0.
    await expect(
      'S4',
      page,
      () => {
        const el = document.querySelector('[data-component="activity-panel"]');
        const n = parseInt(el?.getAttribute('data-events-shown') ?? '0', 10);
        return n > 0;
      },
      'expected [data-component="activity-panel"][data-events-shown > 0]',
    );
    const shown = page
      ? await page.evaluate(() => document.querySelector('[data-component="activity-panel"]')?.getAttribute('data-events-shown'))
      : '(showcase — verify visually)';
    log('S4', `ActivityPanel ✓ (events-shown=${shown})`);
  } finally {
    cleanupCycle(cycle);
  }
}

/**
 * S5 — `forge send-back` writes a parseable verdict file. Seeds a ready-
 * for-review manifest, runs the CLI with a feedback file, asserts the
 * resulting verdict-response.md has the expected shape.
 */
async function S5(_ui, _page) {
  const cycle = newCycle('S5');
  // The AC line shape parse-able by orchestrator/file-verdict.ts is the
  // single-line variant: '- GIVEN <precond> WHEN <action> THEN <expected>'.
  const feedback = `# Send-back feedback

WI-1 missed the boundary check.

## Acceptance criteria

- GIVEN a request with an empty body WHEN the handler runs THEN it returns HTTP 400 with empty body error
`;
  const feedbackPath = join('/tmp', `harness-S5-${cycle.initiativeId}.md`);
  try {
    log('S5', `cycle=${cycle.cycleId}`);
    await narrate('CLI-only — `forge send-back <id> --feedback <f>` writes a parseable verdict-response.md. Nothing happens in the browser; check the stdout for ✓.');
    writeManifest('ready-for-review', cycle.initiativeId);
    writeFileSync(feedbackPath, feedback);

    // Run `forge send-back <id> --feedback <file>`.
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types', 'orchestrator/cli.ts', 'send-back',
        cycle.initiativeId, '--feedback', feedbackPath,
      ],
      { cwd: FORGE_ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      fail('S5', `forge send-back exited ${result.status}\n stdout: ${result.stdout}\n stderr: ${result.stderr}`);
    }

    const verdictPath = join(QDIR('ready-for-review'), `${cycle.initiativeId}.verdict-response.md`);
    if (!existsSync(verdictPath)) {
      fail('S5', `expected verdict-response.md at ${verdictPath}`);
    }
    const written = readFileSync(verdictPath, 'utf8');
    if (!/verdict:\s*send-back/.test(written)) {
      fail('S5', `verdict-response.md missing 'verdict: send-back': ${written.slice(0, 200)}`);
    }
    if (!/empty body/.test(written)) {
      fail('S5', `verdict-response.md missing AC body: ${written.slice(0, 200)}`);
    }
    log('S5', 'verdict written ✓');
  } finally {
    cleanupCycle(cycle);
    try { rmSync(feedbackPath, { force: true }); } catch { /* */ }
  }
}

/**
 * S6 — `forge requeue` moves a failed manifest back to pending/. Mirrors
 * the operator-recovery path the F2.I3 cmd added.
 */
async function S6(_ui, _page) {
  const cycle = newCycle('S6');
  try {
    log('S6', `cycle=${cycle.cycleId}`);
    await narrate('CLI-only — `forge requeue <id>` moves a failed manifest back to pending/. Watch the cycle tab: the new failed cycle flips into pending after the command runs.');
    writeManifest('failed', cycle.initiativeId);
    if (!existsSync(manifestPath('failed', cycle.initiativeId))) {
      fail('S6', `precondition: manifest not in failed/`);
    }

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'orchestrator/cli.ts', 'requeue', cycle.initiativeId],
      { cwd: FORGE_ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      fail('S6', `forge requeue exited ${result.status}\n stdout: ${result.stdout}\n stderr: ${result.stderr}`);
    }

    if (existsSync(manifestPath('failed', cycle.initiativeId))) {
      fail('S6', `manifest still in failed/ after requeue`);
    }
    if (!existsSync(manifestPath('pending', cycle.initiativeId))) {
      fail('S6', `manifest missing from pending/ after requeue`);
    }
    const moved = readFileSync(manifestPath('pending', cycle.initiativeId), 'utf8');
    if (!/requeued-from-/.test(moved)) {
      fail('S6', `expected 'requeued-from-' marker in previous_failure_modes: ${moved.slice(0, 300)}`);
    }
    log('S6', 'manifest moved + marker appended ✓');
  } finally {
    cleanupCycle(cycle);
  }
}

// ---- driver --------------------------------------------------------------

const SCENARIOS = [
  { id: 'S1', name: 'happy-path-ui-flow',   needsBrowser: true,  run: S1 },
  { id: 'S2', name: 'failed-unifier-cycle', needsBrowser: true,  run: S2 },
  { id: 'S3', name: 'cost-rollup',          needsBrowser: true,  run: S3 },
  { id: 'S4', name: 'ui-components-render', needsBrowser: true,  run: S4 },
  { id: 'S5', name: 'send-back-cli',        needsBrowser: false, run: S5 },
  { id: 'S6', name: 'requeue-cli',          needsBrowser: false, run: S6 },
];

async function main() {
  const filtered = flags.only ? SCENARIOS.filter((s) => s.id === flags.only) : SCENARIOS;
  if (filtered.length === 0) {
    console.error(`no scenario matches --only=${flags.only}`);
    process.exit(1);
  }

  const needsBrowser = filtered.some((s) => s.needsBrowser);
  let watch = null;
  let browser = null;
  let page = null;

  if (flags.showcase) {
    // Operator-watchable mode: bring up forge watch, hand the URL to
    // the operator, and let their browser observe each transition.
    console.log('[harness:showcase] starting forge watch (this takes ~15s)…');
    watch = await startWatch();
    globalShowcaseUi = watch;
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  👉 OPEN ${watch.uiUrl} IN YOUR BROWSER NOW`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  bridge: ${watch.bridgeUrl}`);
    console.log('  Scenarios will run with 4s pauses between transitions so');
    console.log('  you can watch each one react. Ctrl-C to abort cleanup.');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    await sleep(5000); // give the operator a moment to open the URL
  } else if (needsBrowser) {
    console.log('[harness] starting forge watch (this takes ~15s)…');
    watch = await startWatch();
    console.log(`[harness] watch ready: ui=${watch.uiUrl} bridge=${watch.bridgeUrl}`);
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    page.on('pageerror', (err) => console.error(`[harness:pageerror] ${err.message}`));
  }

  const results = [];
  for (const scen of filtered) {
    if (flags.showcase) {
      console.log('');
      console.log(`┌──────────────────────────────────────────────────────────`);
      console.log(`│ ▶ ${scen.id} — ${scen.name}`);
      console.log(`└──────────────────────────────────────────────────────────`);
    }
    const t0 = Date.now();
    try {
      await scen.run(watch, page);
      const ms = Date.now() - t0;
      results.push({ id: scen.id, name: scen.name, ok: true, ms });
      console.log(`[harness] ✓ ${scen.id} ${scen.name} (${ms}ms)`);
      if (flags.showcase) await sleep(SHOWCASE_PAUSE_MS);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ id: scen.id, name: scen.name, ok: false, ms, err: err.message });
      console.error(`[harness] ✗ ${scen.id} ${scen.name} (${ms}ms)`);
      console.error(err.message);
      if (!flags.keepGoing) break;
    }
  }

  if (browser) await browser.close();
  if (watch) await stopWatch(watch.proc);

  // Summary table.
  console.log('\n──── harness summary ────');
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.id.padEnd(3)} ${r.name.padEnd(30)} ${r.ms}ms${r.ok ? '' : '   ← ' + r.err.split('\n')[0]}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = SCENARIOS.length - results.length;
  console.log(`  ${results.length - failed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[harness] fatal');
  console.error(err.stack ?? err.message);
  process.exit(1);
});
