#!/usr/bin/env node
/**
 * verify-cycle — autonomous-overnight wrapper around the recorder.
 *
 * Usage:
 *   node scripts/verify-cycle.mjs <initiative-id>
 *
 * Differs from `record-cycle-ui.mjs` in that:
 *   1. Auto-approves the cycle when it lands at `ready-for-review`
 *      (runs `forge review <id> --approve --auto-verify`).
 *   2. Keeps capturing frames through closure + reflection (the post-
 *      operator-approval phases) by polling phase-states until the
 *      cycle log emits `cycle.end`.
 *   3. Writes a manifest summary at the end so the operator can see
 *      the cycle's final state when they wake up.
 *
 * Output dir: forge-ui/.demo-shots/verify/<initiative-id>/
 *
 * Manifest for <initiative-id> must already exist in _queue/pending/.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FORGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const initiativeId = process.argv[2];
if (!initiativeId) {
  console.error('usage: node scripts/verify-cycle.mjs <initiative-id>');
  process.exit(1);
}

const OUT_DIR = join(FORGE_ROOT, 'forge-ui/.demo-shots/verify', initiativeId);
const VIDEO_DIR = join(OUT_DIR, 'video');
const FRAMES_DIR = join(OUT_DIR, 'frames');

function log(msg) { console.log(`[verify ${new Date().toISOString().slice(11, 19)}] ${msg}`); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startWatch() {
  // Reuse existing forge watch on 4124/4123 if up; else spawn.
  const probe = async (url) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 500);
      const res = await fetch(url, { signal: c.signal });
      clearTimeout(t);
      return res.ok;
    } catch { return false; }
  };
  if ((await probe('http://127.0.0.1:4123/api/cycles')) && (await probe('http://localhost:4124/'))) {
    log('reusing existing forge watch on 4124/4123');
    return { proc: null, uiUrl: 'http://localhost:4124', bridgeUrl: 'http://127.0.0.1:4123' };
  }
  return new Promise((res, rej) => {
    const proc = spawn(
      process.execPath,
      ['--experimental-strip-types', 'orchestrator/cli.ts', 'watch', '--no-open'],
      { cwd: FORGE_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let uiUrl = null, bridgeUrl = null;
    const onData = (chunk) => {
      const t = chunk.toString();
      const m1 = t.match(/http:\/\/localhost:\d+/); if (m1 && !uiUrl) uiUrl = m1[0];
      const m2 = t.match(/bridge at (http:\/\/127\.0\.0\.1:\d+)/); if (m2 && !bridgeUrl) bridgeUrl = m2[1];
      if (t.includes('Ready in') && uiUrl && bridgeUrl) res({ proc, uiUrl, bridgeUrl });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', rej);
    setTimeout(() => { if (!uiUrl || !bridgeUrl) rej(new Error('forge watch not ready within 30s')); }, 30000);
  });
}

function stopWatch(proc) {
  if (!proc) return Promise.resolve();
  return new Promise((res) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; res(); };
    proc.on('exit', done);
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* */ }
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* */ } done(); }, 3000);
  });
}

function startServe() {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', 'orchestrator/cli.ts', 'serve', '--once'],
    { cwd: FORGE_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
}

async function findCycleIdForInitiative(bridgeUrl, initiativeId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(`${bridgeUrl}/api/cycles`);
      if (res.ok) {
        const body = await res.json();
        const all = [...(body.live ?? []), ...(body.recent ?? [])];
        const match = all.find((c) => c.initiativeId === initiativeId);
        if (match) return match.cycleId;
      }
    } catch { /* */ }
    await sleep(1000);
  }
  return null;
}

async function captureFrame(page, name) {
  const seq = String((captureFrame._n = (captureFrame._n ?? 0) + 1)).padStart(2, '0');
  const path = join(FRAMES_DIR, `${seq}-${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
    log(`✓ frame ${seq}-${name}`);
  } catch (err) {
    log(`✗ frame ${seq}-${name}: ${err.message}`);
  }
}

async function getPhaseStates(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-phase][data-phase-status]'));
    const states = {};
    for (const r of rows) {
      const phase = r.getAttribute('data-phase');
      const status = r.getAttribute('data-phase-status');
      if (phase && status && !(phase in states)) states[phase] = status;
    }
    return states;
  });
}

async function cycleStatusFromBridge(bridgeUrl, cycleId) {
  try {
    const res = await fetch(`${bridgeUrl}/api/cycles`);
    if (!res.ok) return null;
    const body = await res.json();
    const all = [...(body.live ?? []), ...(body.recent ?? [])];
    const match = all.find((c) => c.cycleId === cycleId);
    return match?.status ?? null;
  } catch { return null; }
}

function autoApprove(initiativeId) {
  log(`auto-approving cycle (forge review ${initiativeId} --approve)…`);
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'orchestrator/cli.ts',
      'review',
      initiativeId,
      '--approve',
      'auto-approved by scripts/verify-cycle.mjs (verification cycle — see initiative manifest)',
    ],
    { cwd: FORGE_ROOT, stdio: 'inherit' },
  );
  if (res.status !== 0) {
    log(`auto-approve failed: exit ${res.status}`);
    return false;
  }
  log('auto-approve succeeded');
  return true;
}

async function cycleEventCountFromLog(cycleId) {
  const logFile = join(FORGE_ROOT, '_logs', cycleId, 'events.jsonl');
  try {
    const raw = readFileSync(logFile, 'utf8');
    return raw.split('\n').filter((l) => l.length > 0).length;
  } catch { return 0; }
}

async function logHasCycleEnd(cycleId) {
  const logFile = join(FORGE_ROOT, '_logs', cycleId, 'events.jsonl');
  try {
    const raw = readFileSync(logFile, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.includes('"phase":"orchestrator"') && line.includes('"event_type":"end"')) return true;
    }
    return false;
  } catch { return false; }
}

function writeIndexHtml() {
  const frames = readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.png')).sort();
  const rows = frames.map((f) => `<figure><img src="frames/${f}" loading="lazy"/><figcaption><code>${f}</code></figcaption></figure>`).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>forge verify cycle — ${initiativeId}</title>
<style>
  body{background:#0d1117;color:#e6edf3;font:14px ui-sans-serif,system-ui,sans-serif;margin:32px auto;max-width:1640px;padding:0 24px}
  h1,h2{letter-spacing:.4px}
  video{width:100%;max-width:1400px;border:1px solid #30363d;border-radius:8px;background:#000}
  figure{margin:24px 0;padding:0}
  figure img{width:100%;border:1px solid #30363d;border-radius:8px;display:block}
  figure figcaption{color:#8b949e;font-family:ui-monospace,Menlo,monospace;padding-top:6px;font-size:12px}
  code{color:#d2a8ff}
</style></head><body>
<h1>forge — verification cycle recording</h1>
<p><code>${initiativeId}</code></p>
<h2>video</h2>
<video src="cycle.webm" controls autoplay muted loop></video>
<h2>frames</h2>
${rows}
</body></html>`;
  writeFileSync(join(OUT_DIR, 'index.html'), html);
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  log('starting forge watch…');
  const watch = await startWatch();
  log(`watch ready: ui=${watch.uiUrl} bridge=${watch.bridgeUrl}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1400 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1400, height: 1400 } },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));

  await page.goto(watch.uiUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('main')?.getAttribute('data-page-ready') === 'true',
    undefined,
    { timeout: 15000 },
  ).catch(() => log('page-ready timed out'));
  await captureFrame(page, 'initial-load');

  log('spawning forge serve --once…');
  const serve = startServe();
  serve.stdout.on('data', (d) => process.stdout.write(d));
  serve.stderr.on('data', (d) => process.stderr.write(d));

  log('waiting for cycle to appear on bridge…');
  const cycleId = await findCycleIdForInitiative(watch.bridgeUrl, initiativeId, Date.now() + 60_000);
  if (!cycleId) {
    log('cycle never appeared — bailing');
    await captureFrame(page, 'cycle-never-claimed');
    await browser.close();
    await stopWatch(watch.proc);
    process.exit(1);
  }
  log(`cycle id: ${cycleId}`);
  try {
    await page.waitForSelector(`[data-cycle-id="${cycleId}"]`, { timeout: 15000 });
    await page.locator(`[data-cycle-id="${cycleId}"]`).first().click();
    await page.waitForFunction(
      (id) => document.querySelector('main')?.getAttribute('data-active-cycle-id') === id,
      cycleId,
      { timeout: 5000 },
    ).catch(() => { /* */ });
    await captureFrame(page, 'cycle-focused');
  } catch (err) {
    log(`click failed: ${err.message}`);
  }

  // Phase-1 capture: while `serve --once` is running. Exits when the
  // cycle hits a terminal phase for the autonomous part (pr-open,
  // failed, etc.) — serve exits at that point.
  //
  // 2026-05-25 fix: previously used Promise.race + a falsy check to
  // detect serve exit. serve exiting with code 0 (clean) made the
  // race return `0`, which evaluates falsy, so the poll never exited
  // and the auto-approve never fired. Use a sentinel object instead.
  const seenPhase = new Map();
  const SERVE_EXITED = Symbol('serve-exited');
  const serveEnd = new Promise((res) => serve.on('exit', () => res(SERVE_EXITED)));
  const phasePoll = (async () => {
    while (true) {
      const r = await Promise.race([serveEnd, sleep(2000)]);
      if (r === SERVE_EXITED) return;
      try {
        const states = await getPhaseStates(page);
        for (const [phase, status] of Object.entries(states)) {
          const prev = seenPhase.get(phase);
          if (prev !== status) {
            seenPhase.set(phase, status);
            await captureFrame(page, `${phase}-${status}`);
          }
        }
      } catch { /* */ }
    }
  })();

  await serveEnd;
  await phasePoll;
  log('serve --once exited');

  // What state did the cycle reach?
  await sleep(2000);
  const status = await cycleStatusFromBridge(watch.bridgeUrl, cycleId);
  log(`cycle status after serve exit: ${status}`);
  await captureFrame(page, `after-serve-${status ?? 'unknown'}`);

  // Auto-approve path: if ready-for-review, kick the approve + capture
  // closure + reflection.
  if (status === 'ready-for-review') {
    const ok = autoApprove(initiativeId);
    if (ok) {
      log('waiting for closure + reflection to complete…');
      const deadline = Date.now() + 10 * 60_000; // 10 min cap
      let lastEventCount = 0;
      while (Date.now() < deadline) {
        const ended = await logHasCycleEnd(cycleId);
        if (ended) {
          log('cycle.end emitted by orchestrator — reflection complete');
          break;
        }
        // Capture frame whenever the event count grows substantially.
        const count = await cycleEventCountFromLog(cycleId);
        if (count > lastEventCount + 4) {
          lastEventCount = count;
          await captureFrame(page, `post-approve-events-${count}`);
        }
        await sleep(3000);
      }
      await sleep(3000);
      await captureFrame(page, 'final-state');
    }
  } else {
    log(`cycle reached non-ready-for-review state (${status}) — no auto-approve`);
  }

  // Capture the video path BEFORE closing.
  let videoSrc = null;
  try { videoSrc = await page.video()?.path(); } catch { /* */ }

  await browser.close();
  await stopWatch(watch.proc);

  if (videoSrc && existsSync(videoSrc)) {
    const dest = join(OUT_DIR, 'cycle.webm');
    try {
      renameSync(videoSrc, dest);
      log(`video → ${dest}`);
    } catch (err) {
      log(`failed to move video: ${err.message}`);
    }
  } else {
    log('no video file produced');
  }

  writeIndexHtml();
  log(`index → ${join(OUT_DIR, 'index.html')}`);

  // Final state report.
  const finalStatus = await cycleStatusFromBridge(watch.bridgeUrl, cycleId);
  const finalEvents = await cycleEventCountFromLog(cycleId);
  const summary = {
    initiativeId,
    cycleId,
    finalStatus,
    totalEvents: finalEvents,
    framesCaptured: readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.png')).length,
    completedAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`summary → ${join(OUT_DIR, 'summary.json')}`);
  log(`final status: ${finalStatus}, ${finalEvents} events, ${summary.framesCaptured} frames`);
  log('done');
}

main().catch((err) => {
  console.error('[verify] fatal');
  console.error(err.stack ?? err.message);
  process.exit(1);
});
