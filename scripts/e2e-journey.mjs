/**
 * e2e-journey — the canonical end-to-end operator journey through the
 * centralised forge UI (ADR 020 + 021), recorded as a video + frame gallery.
 *
 *   node scripts/e2e-journey.mjs
 *
 * This walks the operator's 13-step vision verbatim (docs/operator-journey.md),
 * at a watchable pace, demonstrating the TARGET high-level behaviour:
 *
 *   1.  new idea provided
 *   2.  architect reviews the project + explores edge cases
 *   3.  architect returns questions to clarify
 *   4.  operator answers → planning stage rolls them in
 *   5.  draft → review council → plan options from the council's feedback
 *   6.  on feedback, the architect reruns the last step
 *   7.  on approval → PM
 *   8.  PM plans features + work items
 *   9.  developer loop progresses work items, respecting dependencies
 *   10. unifier reviews + loops to clean the output
 *   11. unifier runs the demo skill → forge-ui-themed demo page
 *   12. operator reviews; Ralph dev-loops rerun with operator input until approve
 *   13. on approval → reflect
 *
 * No live LLM: the architect runner's turns + the autonomous cycle are emulated
 * by seeding the same files/events the real phases write (or will write, for
 * the aspirational steps), grounded in the real cycle event sequence.
 *
 * Output: forge-ui/.demo-shots/e2e/{video/journey.webm, frames/*.png, index.html}.
 * Cleans up the throwaway projects/_e2e-demo/ + _logs/_queue state afterwards.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FORGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = '_e2e-demo';
const projectRoot = join(FORGE_ROOT, 'projects', PROJECT);
const OUT = join(FORGE_ROOT, 'forge-ui/.demo-shots/e2e');
const FRAMES = join(OUT, 'frames');
const VIDEO = join(OUT, 'video');
const IDEA = 'Add a dark-mode toggle to the settings page that follows the OS by default.';
const DATE = new Date().toISOString().slice(0, 10);
const INIT = `INIT-${DATE}-e2e-dark-mode`;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const CYCLE_ID = `${STAMP}_${INIT}`;
const CYCLE_LOG = join(FORGE_ROOT, '_logs', CYCLE_ID);

// Watchable pacing — the recording is a continuous clip a human follows, so
// each beat dwells like a person actually working through that page.
const READ = 4200;  // a page the operator reads carefully (plan, demo)
const WORK = 3200;  // watching autonomous work happen (events fire during this)
const ACT = 1500;   // a brief beat after an action (a click, an answer)
const THINK = 1000; // between live tool bursts so the hex visibly pulses
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QDIR = (q) => join(FORGE_ROOT, '_queue', q);

// ---- emulation helpers (write what the real phases write) -----------------

function archDir(sid) { return join(projectRoot, '_architect', sid); }
function writeStatus(sid, status) {
  const dir = archDir(sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...status, session_id: sid, project: PROJECT, project_repo_path: projectRoot, updated_at: new Date().toISOString() }, null, 2));
}
let archSeq = 0;
function archEvent(sid, eventType, message, metadata = {}) {
  const dir = join(FORGE_ROOT, '_logs', `_architect-${sid}`);
  mkdirSync(dir, { recursive: true });
  archSeq += 1;
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({
    event_id: `EV_arch_${archSeq}`, cycle_id: `_architect-${sid}`, initiative_id: `architect-session-${sid}`,
    started_at: new Date().toISOString(), phase: 'architect', skill: 'architect-runner',
    event_type: eventType, input_refs: [], output_refs: [], message, metadata,
  }) + '\n');
}
/** Stream a sequence of architect tool bursts so the hex visibly pulses, with a
 *  pause between each (step 2: reviewing the project + exploring edge cases). */
async function burst(sid, tools) {
  for (const t of tools) { archEvent(sid, 'tool_use', `tool.${t}`, { tool: t }); await sleep(THINK); }
}
/** Fire a sequence of cycle events with a gap between each, so the live hex
 *  pipeline visibly advances as work is (mock-)done rather than jumping. */
async function paced(thunks, gap = THINK) {
  for (const fn of thunks) { fn(); await sleep(gap); }
}

function writeQuestions(sid) {
  writeFileSync(join(archDir(sid), 'questions.json'), JSON.stringify([
    { question: 'Should dark mode follow the OS setting by default?', header: 'OS sync',
      options: [
        { label: 'Follow OS', description: 'Match the system theme automatically on first load.' },
        { label: 'Manual only', description: 'Default to light; the operator toggles it explicitly.' },
      ] },
    { question: 'Where should the toggle live?', header: 'Placement',
      options: [
        { label: 'Settings page', description: 'A row in the existing settings form.' },
        { label: 'Top nav', description: 'A persistent icon button in the header.' },
      ] },
  ], null, 2));
}
function writePlan(sid, round) {
  const dir = archDir(sid);
  mkdirSync(join(dir, 'manifests'), { recursive: true });
  writeFileSync(join(dir, 'manifests', `${INIT}.md`), [
    '---', `initiative_id: ${INIT}`, `project: ${PROJECT}`, `project_repo_path: ${projectRoot}`,
    `created_at: '${new Date().toISOString()}'`, 'iteration_budget: 4', 'cost_budget_usd: 6', 'phase: pending',
    'origin: architect', 'features:', '  - feature_id: FEAT-1', '    title: Theme context + OS sync', '    depends_on: []',
    '  - feature_id: FEAT-2', '    title: Settings toggle UI', '    depends_on: [FEAT-1]', '---', '',
    '# Dark mode toggle', '', 'GIVEN settings WHEN toggled THEN the theme persists across reloads.',
  ].join('\n'));
  writeFileSync(join(dir, 'PLAN.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px ui-sans-serif,system-ui;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
    h1{font-size:18px}h2{font-size:14px;color:#d2a8ff}.card{border:1px solid #30363d;border-radius:8px;padding:14px;margin:12px 0;background:#161b22}
    .r{color:#7ee787}</style></head>
    <body><h1>PLAN — dark-mode toggle ${round > 1 ? '<span class="r">(revised)</span>' : ''}</h1>
    <p>Operator brief: a dark-mode toggle that follows the OS by default.</p>
    <div class="card"><h2>FEAT-1 Theme context + OS sync</h2><p>GIVEN settings WHEN toggled THEN theme persists across reloads.</p></div>
    <div class="card"><h2>FEAT-2 Settings toggle UI</h2><p>Depends on FEAT-1. A row in the settings form.</p></div></body></html>`);
  writeFileSync(join(dir, 'escalations.json'), JSON.stringify([
    { id: 'esc-0', critic: 'design', question: 'Default theme on first load?',
      options: [{ label: 'Follow OS', rationale: 'Least surprise; matches platform conventions.' }, { label: 'Light', rationale: 'Keeps the brand default for new users.' }] },
    { id: 'esc-1', critic: 'eng', question: 'Persist the preference where?',
      options: [{ label: 'localStorage', rationale: 'Zero backend; instant.' }, { label: 'User profile', rationale: 'Syncs across devices; needs an API call.' }] },
  ], null, 2));
  writeStatus(sid, { phase: 'awaiting-verdict', round, idea: IDEA });
}

let cycleSeq = 0;
function cycleEvent(phase, eventType, message, opts = {}) {
  const { metadata = {}, ...extras } = opts;
  mkdirSync(CYCLE_LOG, { recursive: true });
  cycleSeq += 1;
  appendFileSync(join(CYCLE_LOG, 'events.jsonl'), JSON.stringify({
    event_id: `EV_cyc_${cycleSeq}`, cycle_id: CYCLE_ID, initiative_id: INIT,
    started_at: new Date().toISOString(), phase, skill: phase, event_type: eventType,
    input_refs: [], output_refs: [], message, metadata, ...extras,
  }) + '\n');
}
function moveManifest(from, to) {
  mkdirSync(QDIR(to), { recursive: true });
  renameSync(join(QDIR(from), `${INIT}.md`), join(QDIR(to), `${INIT}.md`));
}
function writeDemoJson(revision) {
  const artifacts = join(CYCLE_LOG, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'demo.json'), JSON.stringify({
    title: `Dark-mode toggle that follows the OS${revision > 1 ? ' (round ' + revision + ')' : ''}`,
    essence: 'Adds a settings toggle; the theme now persists and defaults to the OS preference on first load.',
    project: PROJECT, initiativeId: INIT, baseRef: 'main', changedRef: `forge/${INIT}`,
    diffStat: ' src/theme.ts        | 38 ++++++++\n src/SettingsRow.tsx | 21 +++++\n 2 files changed, 59 insertions(+)',
    acceptanceCriteria: ['GIVEN settings WHEN the toggle is flipped THEN the theme persists across reloads'],
    checkpoints: [
      { label: 'sync', kind: 'harness', caption: 'Theme resolves from the OS preference on first load',
        metrics: [
          { label: 'first-paint theme matches OS', before: 'no', after: 'yes', deltaPct: null, parity: 'diverged' },
          { label: 'preference persisted across reload', before: 'no', after: 'yes', deltaPct: null, parity: 'diverged' },
        ] },
      { label: 'toggle', kind: 'screenshot', caption: 'The settings row gains a dark-mode toggle',
        beforeNote: 'No theme control existed in settings.', afterNote: `A labelled toggle persists the choice.${revision > 1 ? ' Now also keyboard-accessible per review.' : ''}` },
    ],
  }, null, 2));
}

/** Emulate the reflector's Stage-2 emit: the operator-facing questions it writes
 *  to `_logs/<cycleId>/user-questions.json` for the reflect screen to render. */
function writeReflectionQuestions() {
  mkdirSync(CYCLE_LOG, { recursive: true });
  writeFileSync(join(CYCLE_LOG, 'user-questions.json'), JSON.stringify([
    {
      question: 'Was the 2-feature / 2-WI decomposition the right size for this initiative?',
      header: 'WI sizing',
      options: [
        { label: 'Right size', description: 'Two features mapped cleanly to the work.' },
        { label: 'Too small', description: 'Could have been a single feature.' },
        { label: 'Too large', description: 'Should have been split further.' },
      ],
    },
  ], null, 2));
}

// ---- boot + frames --------------------------------------------------------

async function startWatch() {
  try { execSync('fuser -k 4123/tcp 4124/tcp', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(800);
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, ['--experimental-strip-types', 'orchestrator/cli.ts', 'watch', '--no-open'],
      { cwd: FORGE_ROOT, env: { ...process.env, FORGE_ARCHITECT_NO_SPAWN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let uiUrl = null, bridgeUrl = null;
    const onData = (chunk) => {
      const t = chunk.toString();
      const u = t.match(/http:\/\/localhost:\d+/); const b = t.match(/bridge at (http:\/\/127\.0\.0\.1:\d+)/);
      if (b && !bridgeUrl) bridgeUrl = b[1];
      if (u && !uiUrl) uiUrl = u[0];
      if (t.includes('Ready in') && uiUrl && bridgeUrl) res({ proc, uiUrl, bridgeUrl });
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData); proc.on('error', rej);
    setTimeout(() => { if (!uiUrl || !bridgeUrl) rej(new Error('watch not ready in 90s')); }, 90000);
  });
}

const captions = [];
let seq = 0;
async function frame(page, name, caption) {
  seq += 1;
  const file = `${String(seq).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(FRAMES, file), fullPage: true });
  captions.push({ file, caption });
  console.log(`  [${String(seq).padStart(2, '0')}] ${caption}`);
}
function writeIndex(videoName) {
  const figs = captions.map((c) => `<figure><img src="frames/${c.file}" loading="lazy"/><figcaption><code>${c.file}</code> — ${c.caption}</figcaption></figure>`).join('\n');
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>forge — e2e operator journey</title>
<style>body{background:#0d1117;color:#e6edf3;font:14px ui-sans-serif,system-ui;margin:32px auto;max-width:1280px;padding:0 24px}
h1{letter-spacing:.4px}video{width:100%;border:1px solid #30363d;border-radius:8px;background:#000}
figure{margin:24px 0;padding:0}figure img{width:100%;border:1px solid #30363d;border-radius:8px;display:block}
figcaption{color:#8b949e;font-size:12px;padding-top:6px}code{color:#d2a8ff}ol{line-height:1.8}</style></head>
<body><h1>forge — end-to-end operator journey (centralised UI)</h1>
<p>The operator's 13-step vision (docs/operator-journey.md), walked at a watchable pace. Recorded ${new Date().toISOString()}.</p>
<h2>video</h2><video src="${videoName}" controls autoplay muted loop></video>
<h2>frames</h2>${figs}</body></html>`);
}

// ---- the journey ----------------------------------------------------------

async function main() {
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(join(projectRoot, '_architect'), { recursive: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(VIDEO, { recursive: true });

  console.log('[e2e] booting forge watch (cold compile ~20-40s)…');
  const watch = await startWatch();
  console.log(`[e2e] ready: ${watch.uiUrl}`);
  try { execSync(`curl -s -m 60 ${watch.uiUrl}/ -o /dev/null`); } catch { /* warm */ }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 1600 }, recordVideo: { dir: VIDEO, size: { width: 1380, height: 1600 } } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  try {
    // STEP 1 — new idea provided.
    await page.goto(watch.uiUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main[data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-section="new-idea"]', { timeout: 10000 });
    await page.locator('[data-section="new-idea"] [data-field="project"]').fill(PROJECT);
    // Type the idea like a person would, not a paste, so the video shows it being written.
    await page.locator('[data-section="new-idea"] [data-field="idea"]').click();
    await page.locator('[data-section="new-idea"] [data-field="idea"]').pressSequentially(IDEA, { delay: 28 });
    await sleep(THINK);
    await frame(page, 'step01-new-idea', 'Step 1 — the operator types the idea on the dashboard');
    // Show the deliberate button press that kicks off the architect.
    await page.locator('[data-action="start-architect"]').hover();
    await sleep(ACT);
    await frame(page, 'step01b-start', 'Step 1 — the operator presses "Start architect"');
    await page.locator('[data-action="start-architect"]').click();
    await page.waitForURL(/\/architect\//, { timeout: 15000 });
    const sid = decodeURIComponent(page.url().split('/architect/')[1]);
    console.log(`[e2e] architect session: ${sid}`);

    // STEP 2 — architect reviews the project + explores edge cases (live hex bursts).
    writeStatus(sid, { phase: 'interviewing', round: 1, idea: IDEA });
    archEvent(sid, 'start', 'architect turn (phase=interviewing, round=1)');
    await page.waitForSelector('[data-component="architect-hex"]', { timeout: 15000 });
    await burst(sid, ['Read', 'Grep', 'Glob', 'Read', 'Grep']); // reviewing project + brain, exploring edge cases
    await frame(page, 'step02-architect-explores', 'Step 2 — the architect reviews the project + explores edge cases (live bursts on the hex)');

    // STEP 3 — architect returns questions to clarify.
    writeQuestions(sid);
    writeStatus(sid, { phase: 'awaiting-answers', round: 1, idea: IDEA });
    archEvent(sid, 'log', 'interview round 1 — 2 question(s) for the operator');
    await page.waitForSelector('[data-section="architect-interview"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step03-architect-questions', 'Step 3 — the architect returns clarifying questions');

    // STEP 4 — operator answers; planning stage rolls them in.
    await page.locator('[data-question-index="0"] input[type="radio"]').first().check();
    await page.locator('[data-question-index="1"] input[type="radio"]').first().check();
    await sleep(THINK);
    await frame(page, 'step04-operator-answers', 'Step 4 — the operator answers; the architect will roll the answers into planning');
    await page.locator('[data-action="submit-answers"]').click();
    await sleep(ACT);
    // The architect takes its planning turn; the screen updates live (WS) — no reload.
    writeStatus(sid, { phase: 'drafting', round: 2, idea: IDEA });
    archEvent(sid, 'start', 'architect turn (phase=drafting) — rolling in answers');
    await page.waitForSelector('[data-section="architect-interview"]', { state: 'detached', timeout: 8000 }).catch(() => {});
    await burst(sid, ['Read', 'Edit']);
    await frame(page, 'step04b-planning', 'Step 4 — planning stage: the architect drafts with the answers folded in');

    // STEP 5 — draft → review council → plan options from the council's feedback.
    archEvent(sid, 'tool_use', 'tool.council', { tool: 'council:ceo/eng/design/dx' });
    await burst(sid, ['council', 'council', 'council']);
    writePlan(sid, 1);
    archEvent(sid, 'log', 'plan-emitted (council surfaced 2 design decisions)');
    await page.waitForSelector('[data-section="plan-gate"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step05-council-plan', 'Step 5 — the council reviewed the draft; the plan presents options shaped by its feedback');

    // STEP 6 — on operator feedback, the architect reruns the last step.
    await page.locator('[data-component="plan-gate"] [data-field="rationale"], [data-section="plan-gate"] [data-field="rationale"]').first()
      .fill('Make the toggle keyboard-accessible and confirm focus order before drafting.').catch(() => {});
    await frame(page, 'step06-send-back', 'Step 6 — the operator sends the plan back with feedback');
    await page.locator('[data-action="revise-plan"]').click();
    await sleep(ACT);
    // The architect reruns the last step (re-council + re-plan); the screen
    // transitions live through "drafting" back to a fresh PLAN gate.
    writeStatus(sid, { phase: 'drafting', round: 3, idea: IDEA });
    archEvent(sid, 'start', 'architect turn (phase=drafting) — rerun with operator feedback');
    await page.waitForSelector('[data-section="plan-gate"]', { state: 'detached', timeout: 8000 }).catch(() => {});
    await burst(sid, ['Read', 'council', 'council']);
    writePlan(sid, 2);
    archEvent(sid, 'log', 'plan-emitted (revised — keyboard-accessible)');
    await page.waitForSelector('[data-section="plan-gate"][data-decisions-resolved="false"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step06b-replan', 'Step 6 — the architect reran the last step; the revised plan is re-presented');

    // STEP 7 — on operator approval → PM. Approve, then take the natural
    // in-UI transition ("Watch it build →") back to the dashboard (client-side,
    // no reload) — the journey stays one continuous clip.
    await page.locator('[data-escalation-id="esc-0"] input[type="radio"]').first().check();
    await page.locator('[data-escalation-id="esc-1"] input[type="radio"]').first().check();
    await page.waitForSelector('[data-section="plan-gate"][data-decisions-resolved="true"]', { timeout: 5000 });
    await sleep(ACT);
    await frame(page, 'step07-approve', 'Step 7 — the operator resolves the decisions and approves');
    await page.locator('[data-action="approve-plan"]').click();
    await sleep(ACT);
    // Emulate finalize → the autonomous loop claims the initiative.
    mkdirSync(QDIR('pending'), { recursive: true });
    execSync(`cp ${join(archDir(sid), 'manifests', `${INIT}.md`)} ${join(QDIR('pending'), `${INIT}.md`)}`);
    writeStatus(sid, { phase: 'committed', round: 3, idea: IDEA });
    cycleEvent('orchestrator', 'start', 'cycle.start', { metadata: { origin: 'architect' } });
    // Record the architect's work + cost in the cycle's lineage so its hex on
    // the dashboard pipeline shows GREEN with a cost pill (the architect ran in
    // the in-UI session before this cycle).
    cycleEvent('architect', 'start', 'architect (in-UI session) — idea → plan');
    cycleEvent('architect', 'end', 'architect.end', { cost_usd: 0.46, duration_ms: 95000 });
    moveManifest('pending', 'in-flight');
    // The screen flips to "Approved — Watch it build →" once finalize lands; take it.
    await page.waitForSelector('[data-action="watch-it-build"]', { timeout: 15000 });
    await sleep(ACT);
    await page.locator('[data-action="watch-it-build"]').click(); // natural transition → dashboard
    await page.waitForSelector(`[data-cycle-id="${CYCLE_ID}"]`, { timeout: 15000 });
    await sleep(ACT);
    await frame(page, 'step07b-to-pm', 'Step 7 — approved; "Watch it build →" lands on the dashboard, cycle live');

    // STEP 8 — PM plans features + work items (events stream live to the pipeline).
    await paced([
      () => cycleEvent('project-manager', 'start', 'pm phase start'),
      () => cycleEvent('project-manager', 'tool_use', 'pm.brain-query', { metadata: { tool: 'brain-query' } }),
      () => cycleEvent('project-manager', 'log', 'pm.feature-decomposed', { metadata: { feature_id: 'FEAT-1' } }),
      () => cycleEvent('project-manager', 'log', 'pm.feature-decomposed', { metadata: { feature_id: 'FEAT-2' } }),
      () => cycleEvent('project-manager', 'log', 'pm.work-item-emitted', { metadata: { work_item_id: 'WI-1', feature_id: 'FEAT-1' } }),
      () => cycleEvent('project-manager', 'log', 'pm.work-item-emitted', { metadata: { work_item_id: 'WI-2', feature_id: 'FEAT-2' } }),
      () => cycleEvent('project-manager', 'end', 'pm.end', { cost_usd: 0.31, duration_ms: 28000, metadata: { work_item_count: 2 } }),
    ]);
    await sleep(WORK);
    await frame(page, 'step08-pm', 'Step 8 — the PM plans 2 features + work items (the pipeline advances live)');

    // STEP 9 — developer loop progresses WIs, respecting dependencies. WI-1
    // runs and goes GREEN (per-WI `end`); only THEN does WI-2 (depends_on
    // FEAT-1) start. The dev-loop PHASE hex stays blue throughout (per-WI ends
    // are non-terminal for the phase).
    await paced([
      () => cycleEvent('developer-loop', 'start', 'dev-loop start'),
      () => cycleEvent('developer-loop', 'tool_use', 'tool.Edit', { metadata: { work_item_id: 'WI-1', tool: 'Edit' } }),
      () => cycleEvent('developer-loop', 'iteration', 'WI-1 iteration', { iteration: 1, metadata: { work_item_id: 'WI-1' } }),
      () => cycleEvent('developer-loop', 'end', 'WI-1 complete', { metadata: { work_item_id: 'WI-1' } }), // → WI-1 green
    ]);
    await sleep(WORK);
    await frame(page, 'step09-dev-loop', 'Step 9 — WI-1 done (green); WI-2 (depends on FEAT-1) only now starts');
    await paced([
      () => cycleEvent('developer-loop', 'tool_use', 'tool.Edit', { metadata: { work_item_id: 'WI-2', tool: 'Edit' } }),
      () => cycleEvent('developer-loop', 'iteration', 'WI-2 iteration', { iteration: 1, metadata: { work_item_id: 'WI-2' } }),
      () => cycleEvent('developer-loop', 'end', 'WI-2 complete', { metadata: { work_item_id: 'WI-2' } }), // → WI-2 green
    ]);
    await sleep(WORK);
    await frame(page, 'step09b-wis-green', 'Step 9 — both work items green; the dev-loop hex stays blue (unifier next)');

    // STEP 10 — unifier reviews + loops to clean the output.
    await paced([
      () => cycleEvent('developer-loop', 'log', 'unifier.start — reviewing the merged work-item output'),
      () => cycleEvent('developer-loop', 'tool_use', 'tool.Bash', { metadata: { tool: 'Bash: npm test' } }),
      () => cycleEvent('developer-loop', 'log', 'unifier.gate — initiative gate green; cleaning output'),
    ]);
    await sleep(WORK);
    await frame(page, 'step10-unifier-clean', 'Step 10 — the unifier reviews the whole branch and loops to clean the output');

    // STEP 11 — unifier runs the demo skill → forge-ui-themed demo page; cycle ready.
    await paced([
      () => cycleEvent('developer-loop', 'log', 'unifier.demo-skill — authoring demo.json (forge-ui themed)'),
      () => cycleEvent('developer-loop', 'tool_use', 'tool.Bash', { metadata: { tool: 'Bash: forge demo render' } }),
      () => { writeDemoJson(1); cycleEvent('developer-loop', 'end', 'ralph.end', { cost_usd: 0.92, duration_ms: 140000 }); },
      () => cycleEvent('review-loop', 'start', 'review-loop start'),
      () => cycleEvent('review-loop', 'log', 'reviewer.pr-opened'),
      () => cycleEvent('review-loop', 'end', 'review-loop end', { cost_usd: 0.21 }),
      () => cycleEvent('closure', 'start', 'closure.start'),
      () => cycleEvent('closure', 'log', 'closure.manifest-moved-to-ready-for-review'),
      () => cycleEvent('closure', 'end', 'closure.end'),
    ]);
    moveManifest('in-flight', 'ready-for-review');
    await page.waitForSelector(`[data-action="open-review"][href*="${INIT}"]`, { timeout: 15000 });
    await sleep(WORK);
    await frame(page, 'step11-demo-ready', 'Step 11 — the unifier ran the demo skill; a "Review →" entry appears');

    // STEP 12 — operator reviews; Ralph dev-loops rerun with operator input until approve.
    await page.locator(`[data-action="open-review"][href*="${INIT}"]`).click(); // natural transition → review
    await page.waitForSelector('main[data-page="review-cycle"][data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-section="demo-comparison"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step12-review-demo', 'Step 12 — the operator reviews the themed demo page');
    // Send back with a new acceptance criterion.
    await page.locator('[data-component="verdict-form"] input[type="radio"]').nth(1).check();
    await page.locator('[data-component="verdict-form"] textarea').fill('Close — but the toggle must be operable by keyboard before this merges.');
    await page.locator('[data-component="verdict-form"] [data-section="acceptance-criteria"] input').nth(0).fill('settings');
    await page.locator('[data-component="verdict-form"] [data-section="acceptance-criteria"] input').nth(1).fill('using only the keyboard');
    await page.locator('[data-component="verdict-form"] [data-section="acceptance-criteria"] input').nth(2).fill('the toggle is reachable and operable');
    await sleep(ACT);
    await frame(page, 'step12b-send-back', 'Step 12 — operator sends back with a new acceptance criterion (keyboard access)');
    await page.locator('[data-action="send-back"]').click();
    await sleep(ACT);
    // Return to the dashboard (natural) while the dev-loop reruns on the feedback.
    await page.locator('[data-action="back-to-dashboard"]').click();
    await page.waitForSelector('main[data-page-ready="true"]', { timeout: 15000 });
    moveManifest('ready-for-review', 'in-flight');
    await paced([
      () => cycleEvent('developer-loop', 'start', 'dev-loop rerun — addressing review feedback'),
      () => cycleEvent('developer-loop', 'tool_use', 'tool.Edit', { metadata: { work_item_id: 'WI-2', tool: 'Edit' } }),
      () => cycleEvent('developer-loop', 'log', 'unifier.demo-skill — re-rendering demo.json (keyboard access)'),
      () => { writeDemoJson(2); cycleEvent('developer-loop', 'end', 'ralph.end (round 2)'); },
    ]);
    moveManifest('in-flight', 'ready-for-review');
    await sleep(WORK);
    await frame(page, 'step12c-rerun', 'Step 12 — the dev-loop reran on the operator feedback; back to "Review →"');
    // Re-review: the updated demo + a fresh verdict.
    await page.locator(`[data-action="open-review"][href*="${INIT}"]`).click();
    await page.waitForSelector('[data-section="demo-comparison"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step12d-re-review', 'Step 12 — the operator re-reviews the updated demo (now keyboard-accessible)');

    // STEP 13 — approve → merge → reflect (its own page) → done.
    await page.locator('[data-component="verdict-form"] textarea').fill('LGTM — follows the OS, persists, and is keyboard-accessible. All ACs met.');
    await sleep(ACT);
    await frame(page, 'step13-approve', 'Step 13 — the operator approves');
    await page.locator('[data-action="approve-and-merge"]').click();
    await page.waitForSelector('[data-component="verdict-form"][data-form-state="submitted"]', { timeout: 10000 }).catch(() => {});
    // Closure merges; the reflector emits its Stage-2 questions (the human moment).
    cycleEvent('closure', 'log', 'closure.pr-merged');
    moveManifest('ready-for-review', 'done');
    cycleEvent('reflection', 'start', 'reflection.start');
    cycleEvent('reflection', 'tool_use', 'reflection.brain-query', { metadata: { tool: 'brain-query' } });
    writeReflectionQuestions();
    await page.waitForSelector('[data-action="open-reflect"]', { timeout: 15000 });
    await sleep(ACT);
    await frame(page, 'step13b-reflect-link', 'Step 13 — merged; "Reflect on this cycle →" surfaces the final human moment');

    // The reflection screen — the third moment, in-UI.
    await page.locator('[data-action="open-reflect"]').click();
    await page.waitForSelector('main[data-page="reflect-cycle"][data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-section="reflect-questions"]', { timeout: 15000 });
    await sleep(READ);
    await frame(page, 'step13c-reflect-page', 'Step 13 — the reflection screen asks how the cycle went');
    await page.locator('[data-question-index="0"] input[type="radio"]').first().check();
    await page.locator('[data-field="freeform"]').fill('Dependency ordering held; the keyboard-access send-back was the right call.');
    await sleep(ACT);
    await page.locator('[data-action="submit-reflection"]').click();
    await page.waitForSelector('[data-section="reflect-done"]', { timeout: 10000 }).catch(() => {});
    await paced([
      () => cycleEvent('reflection', 'tool_use', 'reflection.write', { metadata: { tool: 'Write brain theme' } }),
      () => cycleEvent('reflection', 'end', 'reflection.end', { cost_usd: 0.12 }),
    ]);
    await sleep(ACT);
    await frame(page, 'step13d-reflected', 'Step 13 — feedback captured; the reflector folds it into the brain');

    // The logical endpoint: the whole completed cycle with per-phase costs.
    await page.locator('[data-action="back-to-dashboard"]').click();
    await page.waitForSelector('main[data-page-ready="true"]', { timeout: 15000 });
    await page.locator(`[data-cycle-id="${CYCLE_ID}"]`).click().catch(() => {}); // select OUR completed cycle
    await page.waitForSelector(`[data-cycle-id="${CYCLE_ID}"][data-cycle-status="done"]`, { timeout: 15000 }).catch(() => {});
    await sleep(WORK);
    await frame(page, 'step13e-cycle-complete', 'Done — the full cycle, every phase green with its cost, in the hex pane');

    console.log('\n[e2e] journey complete.');
  } finally {
    await ctx.close();
    await browser.close();
    try { process.kill(-watch.proc.pid, 'SIGKILL'); } catch { /* */ }
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(CYCLE_LOG, { recursive: true, force: true });
    for (const q of ['pending', 'in-flight', 'ready-for-review', 'done', 'failed']) {
      try { rmSync(join(QDIR(q), `${INIT}.md`), { force: true }); } catch { /* */ }
      try { rmSync(join(QDIR(q), `${INIT}.verdict-response.md`), { force: true }); } catch { /* */ }
    }
    try {
      for (const d of readdirSync(join(FORGE_ROOT, '_logs'))) {
        if (d.startsWith('_architect-')) rmSync(join(FORGE_ROOT, '_logs', d), { recursive: true, force: true });
      }
    } catch { /* */ }
  }

  const vids = readdirSync(VIDEO).filter((f) => f.endsWith('.webm'));
  let videoName = vids[0] ?? '';
  if (videoName) { renameSync(join(VIDEO, videoName), join(VIDEO, 'journey.webm')); videoName = 'video/journey.webm'; }
  writeIndex(videoName);
  console.log(`[e2e] OK — ${OUT}/index.html (${captions.length} frames + video)`);
}

main().catch((err) => { console.error(err); rmSync(projectRoot, { recursive: true, force: true }); process.exit(1); });
