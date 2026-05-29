/**
 * D3/D4 gallery — boots forge watch, seeds two in-UI architect sessions
 * (one mid-interview, one plan-ready), and screenshots the operator surface in
 * its key states for the design-alignment sign-off gate (ADR 020).
 *
 *   node scripts/architect-gallery.mjs
 *
 * Output: forge-ui/.demo-shots/journey/architect/{01..}.png + index.html
 * Seeds a throwaway `projects/_gallery-demo/` (gitignored) and removes it after.
 * FORGE_ARCHITECT_NO_SPAWN=1 keeps the seeded sessions from spawning a real LLM.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FORGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = '_gallery-demo';
const projectDir = join(FORGE_ROOT, 'projects', PROJECT);
const archDir = join(projectDir, '_architect');
const OUT = join(FORGE_ROOT, 'forge-ui/.demo-shots/journey/architect');

function seedSession(sid, status, files) {
  const dir = join(archDir, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({
    session_id: sid, project: PROJECT, project_repo_path: projectDir,
    round: status.round, phase: status.phase, idea: status.idea,
    updated_at: new Date().toISOString(),
  }, null, 2));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

function seed() {
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(archDir, { recursive: true });
  // 1) mid-interview session
  seedSession('2026-05-29T14-00-00', {
    phase: 'awaiting-answers', round: 1, idea: 'Add a dark-mode toggle to the settings page.',
  }, {
    'questions.json': [
      {
        question: 'Should dark mode follow the OS setting by default?',
        header: 'OS sync',
        options: [
          { label: 'Follow OS', description: 'Match the system theme automatically on first load.' },
          { label: 'Manual only', description: 'Default to light; the operator toggles it explicitly.' },
        ],
      },
      {
        question: 'Where should the toggle live?',
        header: 'Placement',
        options: [
          { label: 'Settings page', description: 'A row in the existing settings form.' },
          { label: 'Top nav', description: 'A persistent icon button in the header.' },
        ],
      },
    ],
  });
  // 2) plan-ready session
  seedSession('2026-05-29T15-00-00', {
    phase: 'awaiting-verdict', round: 2, idea: 'Add a dark-mode toggle to the settings page.',
  }, {
    'PLAN.html': `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font:14px ui-sans-serif,system-ui;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
      h1{font-size:18px}h2{font-size:14px;color:#d2a8ff}.card{border:1px solid #30363d;border-radius:8px;padding:14px;margin:12px 0;background:#161b22}
    </style></head><body><h1>PLAN — dark-mode toggle</h1>
    <p>Operator brief: add a dark-mode toggle that follows the OS by default.</p>
    <div class="card"><h2>FEAT-1 Theme context + OS sync</h2><p>GIVEN settings WHEN toggled THEN theme persists across reloads.</p></div>
    <div class="card"><h2>FEAT-2 Settings toggle UI</h2><p>Depends on FEAT-1. A row in the settings form.</p></div>
    </body></html>`,
    'escalations.json': [
      { id: 'esc-0', critic: 'design', question: 'Default theme on first load?',
        options: [
          { label: 'Follow OS', rationale: 'Least surprise; matches platform conventions.' },
          { label: 'Light', rationale: 'Keeps the brand default consistent for new users.' },
        ] },
      { id: 'esc-1', critic: 'eng', question: 'Persist the preference where?',
        options: [
          { label: 'localStorage', rationale: 'Zero backend; instant.' },
          { label: 'User profile', rationale: 'Syncs across devices; needs an API call.' },
        ] },
    ],
  });
}

async function startWatch() {
  try { execSync('fuser -k 4123/tcp 4124/tcp', { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 800));
  return new Promise((res, rej) => {
    const proc = spawn(
      process.execPath,
      ['--experimental-strip-types', 'orchestrator/cli.ts', 'watch', '--no-open'],
      { cwd: FORGE_ROOT, env: { ...process.env, FORGE_ARCHITECT_NO_SPAWN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let uiUrl = null, bridgeUrl = null;
    const onData = (chunk) => {
      const text = chunk.toString();
      const ui = text.match(/http:\/\/localhost:\d+/);
      const br = text.match(/bridge at (http:\/\/127\.0\.0\.1:\d+)/);
      if (br && !bridgeUrl) bridgeUrl = br[1];
      if (ui && !uiUrl) uiUrl = ui[0];
      if (text.includes('Ready in') && uiUrl && bridgeUrl) res({ proc, uiUrl, bridgeUrl });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', rej);
    setTimeout(() => { if (!uiUrl || !bridgeUrl) rej(new Error('watch not ready in 90s')); }, 90000);
  });
}

let seq = 0;
async function shot(page, name) {
  seq += 1;
  const file = `${String(seq).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: true });
  console.log(`  shot ${file}`);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  seed();
  console.log('[gallery] booting forge watch (cold compile ~20-40s)…');
  const watch = await startWatch();
  console.log(`[gallery] ready: ${watch.uiUrl}`);
  // Warm the page once (cold compile happens on first hit).
  try { execSync(`curl -s -m 60 ${watch.uiUrl}/ -o /dev/null`); } catch { /* */ }
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1600 } })).newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  const planSid = '2026-05-29T15-00-00';
  const interviewSid = '2026-05-29T14-00-00';
  try {
    // 1) Primary dashboard — compact launcher with a "Review plan →" row.
    await page.goto(watch.uiUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main[data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-section="architect"]', { timeout: 10000 });
    await page.waitForSelector(`[data-architect-session-id="${planSid}"][data-architect-phase="awaiting-verdict"]`, { timeout: 10000 });
    await shot(page, 'primary-dashboard-launcher');

    // 2) Dedicated plan screen — architect hex + rich PLAN.html, decisions unresolved.
    await page.goto(`${watch.uiUrl}/architect/${planSid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main[data-page="architect-session"][data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-component="architect-hex"]', { timeout: 10000 });
    await page.waitForSelector('[data-section="plan-gate"][data-decisions-resolved="false"]', { timeout: 10000 });
    await shot(page, 'plan-screen-unresolved');

    // Resolve every decision → Approve enabled.
    for (const id of ['esc-0', 'esc-1']) {
      await page.locator(`[data-escalation-id="${id}"] input[type="radio"]`).first().check();
    }
    await page.waitForSelector('[data-section="plan-gate"][data-decisions-resolved="true"]', { timeout: 5000 });
    await shot(page, 'plan-screen-resolved');

    // 3) Dedicated screen — interview round for the other session.
    await page.goto(`${watch.uiUrl}/architect/${interviewSid}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main[data-page="architect-session"][data-page-ready="true"]', { timeout: 30000 });
    await page.waitForSelector('[data-section="architect-interview"]', { timeout: 10000 });
    await shot(page, 'plan-screen-interview');
    for (let i = 0; i < 2; i += 1) {
      await page.locator(`[data-question-index="${i}"] input[type="radio"]`).first().check();
    }
    await page.waitForSelector('[data-section="architect-interview"][data-questions-answered="true"]', { timeout: 5000 });
    await shot(page, 'plan-screen-interview-answered');

    console.log('\n[gallery] OK — screenshots in forge-ui/.demo-shots/journey/architect/');
  } finally {
    await browser.close();
    try { process.kill(-watch.proc.pid, 'SIGKILL'); } catch { /* */ }
    rmSync(projectDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); rmSync(projectDir, { recursive: true, force: true }); process.exit(1); });
