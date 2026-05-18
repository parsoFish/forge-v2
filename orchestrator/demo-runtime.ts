/**
 * Demo runtime — build / serve / Playwright-spec / video-harvest helpers.
 *
 * Extracted from demo.ts (Phase 3 size split) so demo.ts stays under the
 * size norm and the "make the app runnable + drive a spec against it"
 * machinery is one named module. `generateComparisonDemo` (demo.ts)
 * imports the entry points; the rest are module-internal.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { type DemoBuildStatus } from './demo-html.ts';

function sh(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { ok: boolean; tail: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
    });
    return { ok: true, tail: out.slice(-800) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const tail = (e.stderr || e.stdout || e.message || 'unknown error').toString().slice(-800);
    return { ok: false, tail };
  }
}

/**
 * Install deps then optionally build. The goal is "make the app runnable",
 * not perfect dependency hygiene — many real projects (e.g. trafficGame's
 * eslint-plugin-import vs eslint@9 peer conflict) fail a strict `npm ci` but
 * run fine with `--legacy-peer-deps`. Fallback chain:
 *   1. npm ci                       (fast, exact, when lockfile is in sync)
 *   2. npm ci --legacy-peer-deps    (peer-dep conflicts only)
 *   3. npm install --legacy-peer-deps (lockfile drift / no lockfile)
 */
function installDeps(treePath: string): { ok: boolean; how: string; tail: string } {
  const hasLock = existsSync(join(treePath, 'package-lock.json'));
  const attempts: Array<{ how: string; args: string[] }> = hasLock
    ? [
        { how: 'npm ci', args: ['ci', '--no-audit', '--no-fund'] },
        { how: 'npm ci --legacy-peer-deps', args: ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'] },
        { how: 'npm install --legacy-peer-deps', args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'] },
      ]
    : [
        { how: 'npm install', args: ['install', '--no-audit', '--no-fund'] },
        { how: 'npm install --legacy-peer-deps', args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'] },
      ];
  let lastTail = '';
  for (const a of attempts) {
    const r = sh('npm', a.args, treePath, 600_000);
    if (r.ok) return { ok: true, how: a.how, tail: r.tail };
    lastTail = r.tail;
  }
  return { ok: false, how: attempts[attempts.length - 1].how, tail: lastTail };
}

/** Install deps + optional build. Returns a build status. */
export function buildTree(treePath: string, runBuild: boolean): DemoBuildStatus {
  const install = installDeps(treePath);
  if (!install.ok) return { ok: false, detail: `dependency install failed (last: ${install.how}): ${install.tail}` };
  if (runBuild) {
    const pkg = readPackageJson(treePath);
    if (pkg?.scripts?.build) {
      const b = sh('npm', ['run', 'build'], treePath, 600_000);
      if (!b.ok) return { ok: false, detail: `npm run build failed: ${b.tail}` };
      return { ok: true, detail: `${install.how} + build ok` };
    }
  }
  return { ok: true, detail: `${install.how} ok` };
}

type PkgJson = { scripts?: Record<string, string> };
function readPackageJson(treePath: string): PkgJson | null {
  try {
    return JSON.parse(readFileSync(join(treePath, 'package.json'), 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

const CANDIDATE_URLS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:5174',
];

async function probe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/** Candidate ports already answering BEFORE we spawn our server. */
async function ambientUrls(): Promise<Set<string>> {
  const live = await Promise.all(
    CANDIDATE_URLS.map(async (u) => ((await probe(u, 500)) ? u : null)),
  );
  return new Set(live.filter((u): u is string => u !== null));
}

/**
 * Poll for OUR server. `exclude` is the set of ports that were already
 * occupied by unrelated servers before we spawned ours — never latch onto
 * those (HIGH-2: a stray `npm run dev` from another project on :3000 would
 * otherwise capture screenshots of the wrong app silently).
 */
async function waitForServer(timeoutMs: number, exclude: Set<string>): Promise<string | null> {
  const start = Date.now();
  const targets = CANDIDATE_URLS.filter((u) => !exclude.has(u));
  while (Date.now() - start < timeoutMs) {
    for (const url of targets) {
      if (await probe(url, 2000)) return url;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

type ServerHandle = { url: string; stop: () => Promise<void> };

/**
 * Start the project's server (prefer `dev`, else `preview`) detached, poll
 * for it to answer (excluding ambient pre-existing servers), return its URL
 * + an async stop() that signals the process group and waits a short drain
 * so the next sequential run can rebind the same port (HIGH-1).
 */
export async function startServer(treePath: string): Promise<ServerHandle | null> {
  const pkg = readPackageJson(treePath);
  // 2026-05-18: prefer `preview` (serves the built, fully-rendered output —
  // deterministic, no HMR settling, fixed port) over `dev` WHENEVER a build
  // output exists. A dev/watch server is non-deterministic to settle and is
  // the class of server that produced stale before/after captures. Fall back
  // to `dev` only when there is no build output to preview.
  const hasBuildOutput = ['dist', 'build', '.output', 'out'].some((d) =>
    existsSync(join(treePath, d)),
  );
  const script =
    hasBuildOutput && pkg?.scripts?.preview
      ? 'preview'
      : pkg?.scripts?.dev
        ? 'dev'
        : pkg?.scripts?.preview
          ? 'preview'
          : null;
  if (!script) return null;
  const exclude = await ambientUrls();
  const child = spawn('npm', ['run', script], {
    cwd: treePath,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, BROWSER: 'none' },
  });
  // HIGH-3: an unstartable child (npm not on PATH, bad script) emits
  // 'error'; with no listener + unref(), Node throws an uncaught error and
  // bypasses the orchestrator's cleanup finally. Swallow it — stop() and
  // waitForServer already handle the "never came up" path.
  child.on('error', () => {});
  child.unref();
  const stop = async (): Promise<void> => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    // Drain: let the OS release the listening socket before the next
    // sequential server tries to bind the same port.
    await new Promise((r) => setTimeout(r, 2500));
  };
  const url = await waitForServer(60_000, exclude);
  if (!url) {
    await stop();
    return null;
  }
  return { url, stop };
}

/**
 * A dedicated Playwright config so the agent's spec runs regardless of the
 * project's own playwright.config.ts (which typically pins `testDir` /
 * custom `projects` / a `webServer` block — all of which would either
 * exclude our spec or fight the orchestrator-managed server). `pwDir` is an
 * IN-TREE directory (`<tree>/.pw-demo`) so the spec's and config's
 * `import '@playwright/test'` resolve against the tree's node_modules —
 * module resolution is relative to the importing file, NOT the npx cwd, so
 * the spec cannot live in the out-of-tree `_work/` dir.
 */
function demoPlaywrightConfig(pwDir: string): string {
  return `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: ${JSON.stringify(pwDir)},
  testMatch: 'demo.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 90000,
  outputDir: ${JSON.stringify(join(pwDir, '_pw-output'))},
  use: {
    baseURL: process.env.DEMO_BASE_URL,
    headless: true,
    screenshot: 'off',
    // Record a video per test. Screenshot checkpoints ignore it; video
    // checkpoints (one test() each, titled = label) get harvested by the
    // orchestrator from outputDir into <captureDir>/<label>.webm.
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;
}

/**
 * Run the agent-authored spec against a running server, capturing
 * screenshots into `screenshotDir`. The spec + config are copied into an
 * in-tree `.pw-demo/` dir (see demoPlaywrightConfig) so their imports
 * resolve; the dir is removed afterwards. Returns the playwright exit
 * status + a log tail (the orchestrator surfaces this — a green build with
 * a red capture is otherwise invisible).
 */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Recursively collect every `*.webm` under `dir`. */
function findWebms(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const abs = join(dir, e);
    let isDir = false;
    try {
      isDir = lstatSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) out.push(...findWebms(abs));
    else if (e.toLowerCase().endsWith('.webm')) out.push(abs);
  }
  return out;
}

/**
 * Map Playwright's per-test videos (in `outputDir`) to the video
 * checkpoints. Playwright names the artifact dir from the test title; the
 * SKILL mandates one `test()` per checkpoint titled exactly the label, so
 * the slug of the label appears in the video's path. Best-effort: copy the
 * first path-slug match to `<captureDir>/<label>.webm`; if exactly one
 * video and one label, map it unconditionally.
 */
function harvestVideos(pwOutputDir: string, captureDir: string, videoLabels: string[]): number {
  if (videoLabels.length === 0) return 0;
  const webms = findWebms(pwOutputDir);
  if (webms.length === 0) return 0;
  mkdirSync(captureDir, { recursive: true });
  let copied = 0;
  for (const label of videoLabels) {
    const sl = slug(label);
    let match = webms.find((w) => slug(w).includes(sl));
    if (!match && webms.length === 1 && videoLabels.length === 1) match = webms[0];
    if (match) {
      try {
        copyFileSync(match, join(captureDir, `${label}.webm`));
        copied += 1;
      } catch {
        /* best-effort */
      }
    }
  }
  return copied;
}

export function runSpec(
  treePath: string,
  demoWorkDir: string,
  baseUrl: string,
  screenshotDir: string,
  videoLabels: string[],
): { ok: boolean; tail: string; videos: number } {
  mkdirSync(screenshotDir, { recursive: true });
  const specSrc = join(demoWorkDir, 'demo.spec.ts');
  if (!existsSync(specSrc)) return { ok: false, tail: 'demo.spec.ts missing', videos: 0 };
  const pwDir = join(treePath, '.pw-demo');
  rmSync(pwDir, { recursive: true, force: true });
  mkdirSync(pwDir, { recursive: true });
  writeFileSync(join(pwDir, 'demo.spec.ts'), readFileSync(specSrc, 'utf8'));
  const configPath = join(pwDir, 'playwright.demo.config.ts');
  writeFileSync(configPath, demoPlaywrightConfig(pwDir));
  // Ensure a browser is present (idempotent, cached after first install).
  sh('npx', ['--yes', 'playwright', 'install', 'chromium'], treePath, 300_000);
  let result: { ok: boolean; tail: string };
  try {
    const out = execFileSync(
      'npx',
      ['--yes', 'playwright', 'test', '--config', configPath, '--reporter=line'],
      {
        cwd: treePath,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 300_000,
        env: {
          ...process.env,
          DEMO_BASE_URL: baseUrl,
          DEMO_SCREENSHOT_DIR: screenshotDir,
          PW_TEST_HTML_REPORT_OPEN: 'never',
        },
      },
    );
    result = { ok: true, tail: out.slice(-800) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    result = { ok: false, tail: ((e.stderr || e.stdout || '') as string).slice(-800) };
  }
  // Harvest videos BEFORE the scratch dir is removed below.
  const videos = harvestVideos(join(pwDir, '_pw-output'), screenshotDir, videoLabels);
  try {
    return { ...result, videos };
  } finally {
    // Never leave the scratch dir in the project tree.
    rmSync(pwDir, { recursive: true, force: true });
  }
}

export function firstExisting(treePath: string, rels: string[]): string | null {
  for (const r of rels) if (existsSync(join(treePath, r))) return r;
  return null;
}

export function findExampleSpec(treePath: string): string | null {
  // Shallow scan of common test dirs for a *.spec.ts the agent can mirror.
  for (const dir of ['tests', 'e2e', 'test', 'playwright']) {
    const abs = join(treePath, dir);
    if (!existsSync(abs)) continue;
    const hit = walkForSpec(abs, treePath, 3);
    if (hit) return hit;
  }
  return null;
}
function walkForSpec(dir: string, root: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const e of entries.sort()) {
    const abs = join(dir, e);
    if (e.endsWith('.spec.ts') || e.endsWith('.spec.tsx')) {
      return abs.slice(root.length + 1);
    }
  }
  for (const e of entries.sort()) {
    const abs = join(dir, e);
    let isDir = false;
    try {
      // lstat (not readdirSync probe) so a circular symlink
      // (e.g. tests/fixtures -> tests) is NOT followed into infinite
      // recursion within the depth budget.
      isDir = lstatSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      const hit = walkForSpec(abs, root, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
