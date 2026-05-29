/**
 * forge-ui-bridge — small Node process that surfaces forge's durable
 * artefacts (events.jsonl + queue dirs) to the browser-side forge-ui
 * over a single WebSocket connection.
 *
 * Started by `forge watch`; outlives no individual cycle. On client
 * connect it sends a snapshot of the current cycle list + recent events,
 * then keeps a tail open on every in-flight cycle's events.jsonl and
 * pushes new lines as they arrive.
 *
 * Stage M2-A scope (read-only):
 *   - GET  /api/health           → 'ok'
 *   - GET  /api/cycles           → { live: Cycle[], recent: Cycle[] }
 *   - GET  /api/events/<cycleId> → full events.jsonl as JSON array
 *   - WS   /ws                   → { type: 'snapshot', ... } once;
 *                                  then { type: 'event', cycleId, event } per new log line;
 *                                  then { type: 'cycle-list-changed' } on queue changes.
 *
 * M2-C adds POST handlers for verdicts (file writes guarded by proper-lockfile).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { WebSocketServer, type WebSocket } from 'ws';

import { getPaths, listInFlight } from '../orchestrator/queue.ts';
import { parseManifest } from '../orchestrator/manifest.ts';
import { fileVerdictPaths } from '../orchestrator/file-verdict.ts';
import { daemonState } from '../orchestrator/daemon.ts';
import type { EventLogEntry } from '../orchestrator/logging.ts';
import {
  listArchitectSessions,
  readStatus,
  writeStatus,
  type ArchitectStatus,
  type ArchitectQuestion,
} from '../orchestrator/architect-runner.ts';

const TAIL_POLL_MS = 200;
const RECENT_CYCLES_MAX = 20;

type Cycle = {
  cycleId: string;
  initiativeId: string;
  project?: string;
  status: 'in-flight' | 'ready-for-review' | 'done' | 'failed' | 'pending';
  startedAt?: string;
  endedAt?: string;
};

type WsOutbound =
  | { type: 'snapshot'; cycles: { live: Cycle[]; recent: Cycle[] } }
  | { type: 'event'; cycleId: string; event: EventLogEntry }
  | { type: 'cycle-list-changed' }
  // ADR 020 — an architect session changed (started, new questions, plan ready,
  // committed). The UI re-fetches `/api/architect/sessions`.
  | { type: 'architect-list-changed' };

export type BridgeOptions = {
  forgeRoot: string;
  port?: number;
  /** Pre-existing snapshot of cycles — defaults to filesystem scan. */
  scanCycles?: () => { live: Cycle[]; recent: Cycle[] };
};

type TailState = {
  cycleId: string;
  filePath: string;
  offset: number;
  timer?: NodeJS.Timeout;
};

export async function startBridge(opts: BridgeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const { forgeRoot } = opts;
  const port = opts.port ?? 0; // 0 = OS-assigned
  // getPaths takes the QUEUE ROOT, not the forge root — _queue/ is a
  // child of forgeRoot.
  const queuePaths = getPaths(resolve(forgeRoot, '_queue'));
  const logsRoot = resolve(forgeRoot, '_logs');
  const projectsRoot = resolve(forgeRoot, 'projects');

  const clients = new Set<WebSocket>();
  const tails = new Map<string, TailState>();
  const queueWatchers: FSWatcher[] = [];
  const architectWatchers: FSWatcher[] = [];

  const broadcast = (msg: WsOutbound): void => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch { /* dropped client */ }
      }
    }
  };

  const scanCycles = opts.scanCycles ?? ((): { live: Cycle[]; recent: Cycle[] } => {
    // The cycle ID is the _logs/<dir> name (timestamp + initiative ID); the
    // queue dirs only carry status. This scan walks _logs/ first to build
    // a list of cycles (most-recent per initiative), then cross-references
    // queue dirs to label each with its current status.
    const live: Cycle[] = [];
    const recent: Cycle[] = [];

    type LogDirInfo = { cycleId: string; initiativeId: string; mtime: number };
    const latestPerInit = new Map<string, LogDirInfo>();
    if (existsSync(logsRoot)) {
      for (const name of readdirSync(logsRoot)) {
        const dir = join(logsRoot, name);
        let mtime = 0;
        try {
          if (!statSync(dir).isDirectory()) continue;
          mtime = statSync(dir).mtimeMs;
        } catch { continue; }
        // Cycle ID format: `<ISO-ish-timestamp>_<INIT-…>`.
        const m = name.match(/_(INIT-.+)$/);
        if (!m) continue;
        const initId = m[1];
        const cur = latestPerInit.get(initId);
        if (!cur || cur.mtime < mtime) {
          latestPerInit.set(initId, { cycleId: name, initiativeId: initId, mtime });
        }
      }
    }

    const queueStatusFor = (initId: string): { status: Cycle['status']; project?: string } | null => {
      const fn = `${initId}.md`;
      const lookups: Array<[string, Cycle['status']]> = [
        [queuePaths.inFlight, 'in-flight'],
        [queuePaths.readyForReview, 'ready-for-review'],
        [queuePaths.done, 'done'],
        [queuePaths.failed, 'failed'],
        [queuePaths.pending, 'pending'],
      ];
      for (const [dir, status] of lookups) {
        const fp = join(dir, fn);
        if (existsSync(fp)) {
          let project: string | undefined;
          try { project = parseManifest(readFileSync(fp, 'utf8')).project; } catch { /* ignore */ }
          return { status, project };
        }
      }
      return null;
    };

    const candidates: Array<{ cycle: Cycle; mtime: number }> = [];
    for (const info of latestPerInit.values()) {
      const q = queueStatusFor(info.initiativeId);
      if (!q) continue; // log dir exists but the queue manifest is gone — orphan, skip
      candidates.push({
        cycle: {
          cycleId: info.cycleId,
          initiativeId: info.initiativeId,
          project: q.project,
          status: q.status,
        },
        mtime: info.mtime,
      });
    }
    // Also surface in-flight / ready-for-review manifests that don't yet
    // have a log dir (just-claimed, pre-first-event).
    const seenInits = new Set([...candidates.map((c) => c.cycle.initiativeId)]);
    for (const name of listInFlight(queuePaths)) {
      const id = name.replace(/\.md$/, '');
      if (seenInits.has(id)) continue;
      let project: string | undefined;
      try { project = parseManifest(readFileSync(join(queuePaths.inFlight, name), 'utf8')).project; } catch { /* */ }
      candidates.push({
        cycle: { cycleId: id, initiativeId: id, project, status: 'in-flight' },
        mtime: Date.now(),
      });
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { cycle } of candidates) {
      if (cycle.status === 'in-flight' || cycle.status === 'ready-for-review') {
        live.push(cycle);
      } else if (recent.length < RECENT_CYCLES_MAX) {
        recent.push(cycle);
      }
    }
    return { live, recent };
  });

  const ensureTailFor = (cycleId: string): void => {
    if (tails.has(cycleId)) return;
    const filePath = join(logsRoot, cycleId, 'events.jsonl');
    if (!existsSync(filePath)) return;
    const state: TailState = { cycleId, filePath, offset: 0 };
    state.timer = setInterval(() => pumpTail(state, (event) => broadcast({ type: 'event', cycleId, event })), TAIL_POLL_MS);
    tails.set(cycleId, state);
  };

  const startTailsForLive = (): void => {
    const cycleIds = new Set<string>();
    try {
      for (const name of readdirSync(logsRoot)) {
        const dir = join(logsRoot, name);
        if (!statSync(dir).isDirectory()) continue;
        if (existsSync(join(dir, 'events.jsonl'))) cycleIds.add(name);
      }
    } catch { /* no _logs dir yet */ }
    // Limit to the most-recent N to avoid tailing the entire history on startup.
    const sorted = [...cycleIds].sort().slice(-RECENT_CYCLES_MAX);
    for (const id of sorted) ensureTailFor(id);
  };

  const watchQueue = (): void => {
    const dirs = [queuePaths.pending, queuePaths.inFlight, queuePaths.readyForReview, queuePaths.done, queuePaths.failed];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      try {
        const w = fsWatch(d, { persistent: false }, () => {
          broadcast({ type: 'cycle-list-changed' });
          // A new cycle may have appeared; pick up its log if so.
          startTailsForLive();
        });
        queueWatchers.push(w);
      } catch { /* fs.watch unavailable */ }
    }
  };

  // ADR 020 — watch each project's `_architect/` dir (recursively where the
  // platform supports it) so the runner's file-checkpoint writes (questions,
  // PLAN, status) push a re-fetch signal to the UI. Mirrors `watchQueue`.
  const watchArchitect = (): void => {
    if (!existsSync(projectsRoot)) return;
    let projects: string[];
    try { projects = readdirSync(projectsRoot); } catch { return; }
    for (const name of projects) {
      const archDir = join(projectsRoot, name, '_architect');
      if (!existsSync(archDir)) continue;
      try {
        const w = fsWatch(archDir, { persistent: false, recursive: true }, () => {
          broadcast({ type: 'architect-list-changed' });
        });
        architectWatchers.push(w);
      } catch {
        // recursive watch unsupported — fall back to a non-recursive watch on
        // the _architect dir (catches new sessions; the UI re-fetches anyway).
        try {
          const w = fsWatch(archDir, { persistent: false }, () => {
            broadcast({ type: 'architect-list-changed' });
          });
          architectWatchers.push(w);
        } catch { /* fs.watch unavailable */ }
      }
    }
  };

  const http = createServer((req, res) => {
    void handleHttp(req, res, {
      scanCycles,
      logsRoot,
      forgeRoot,
      queueRoot: queuePaths.root,
      projectsRoot,
      broadcastArchitectChanged: () => broadcast({ type: 'architect-list-changed' }),
    });
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  const debugWs = process.env.FORGE_BRIDGE_DEBUG === '1';
  let connectionSeq = 0;
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const id = ++connectionSeq;
    if (debugWs) console.error(`[bridge] ws#${id} connect from ${req.socket.remoteAddress} clients=${clients.size}`);
    ws.on('close', (code, reason) => {
      clients.delete(ws);
      if (debugWs) console.error(`[bridge] ws#${id} close code=${code} reason="${reason.toString()}" remaining=${clients.size}`);
    });
    ws.on('error', (err) => {
      clients.delete(ws);
      if (debugWs) console.error(`[bridge] ws#${id} error: ${err.message}`);
    });
    // Initial snapshot.
    try {
      ws.send(JSON.stringify({ type: 'snapshot', cycles: scanCycles() } satisfies WsOutbound));
    } catch { /* socket closed mid-send */ }
  });

  // Bind to all interfaces (0.0.0.0) — required for WSL2 port-forwarding
  // to pick the port up and expose it on Windows localhost. Wait for the
  // 'listening' event before calling address() — listen() is async and
  // server.address() returns null until the bind completes (which would
  // leave us reporting `port: 0` to callers).
  await new Promise<void>((resolveListen, rejectListen) => {
    http.once('error', rejectListen);
    http.once('listening', () => resolveListen());
    http.listen(port, '0.0.0.0');
  });
  startTailsForLive();
  watchQueue();
  watchArchitect();

  const close = async (): Promise<void> => {
    for (const w of queueWatchers) { try { w.close(); } catch { /* ignore */ } }
    for (const w of architectWatchers) { try { w.close(); } catch { /* ignore */ } }
    for (const t of tails.values()) { if (t.timer) clearInterval(t.timer); }
    tails.clear();
    for (const ws of clients) { try { ws.close(); } catch { /* ignore */ } }
    clients.clear();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => http.close(() => r()));
  };

  const address = http.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { url: `http://127.0.0.1:${actualPort}`, close };
}

// ---- HTTP handlers ---------------------------------------------------------

type HttpContext = {
  scanCycles: () => { live: Cycle[]; recent: Cycle[] };
  logsRoot: string;
  forgeRoot: string;
  queueRoot: string;
  /** ADR 020 — `<forgeRoot>/projects`, the root the architect routes walk. */
  projectsRoot: string;
  /** Broadcast an `architect-list-changed` WS message (fsWatch may miss
   *  same-tick writes; the routes call this after they mutate session state). */
  broadcastArchitectChanged: () => void;
};

/** Content-type by extension for served artifacts. `.html` → `text/html` so the
 *  PLAN/DEMO pages render in the operator's browser (ADR 020 + Phase E); all
 *  else stays `text/plain`. */
function contentTypeFor(filename: string): string {
  return filename.toLowerCase().endsWith('.html')
    ? 'text/html; charset=utf-8'
    : 'text/plain; charset=utf-8';
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // CORS preflight for the browser fetch with content-type JSON.
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (method === 'GET' && url === '/api/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (method === 'GET' && url === '/api/cycles') {
    sendJson(res, 200, ctx.scanCycles());
    return;
  }
  if (method === 'GET' && url.startsWith('/api/events/')) {
    const cycleId = decodeURIComponent(url.slice('/api/events/'.length));
    const filePath = join(ctx.logsRoot, cycleId, 'events.jsonl');
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'no events.jsonl for cycle', cycleId });
      return;
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      const events: EventLogEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      sendJson(res, 200, { cycleId, events });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }
  if (method === 'GET' && url.startsWith('/api/cost/')) {
    // U1: cost summary per cycle (total + per-phase + per-skill).
    const cycleId = decodeURIComponent(url.slice('/api/cost/'.length));
    try {
      const { summariseCycle } = await import('./metrics.ts');
      const m = summariseCycle(cycleId, ctx.logsRoot);
      sendJson(res, 200, {
        cycleId,
        totalUsd: m.total_cost_usd,
        perPhase: m.per_phase, // { phase: { cost_usd, iterations, duration_ms } }
        perSkill: m.per_skill, // { skill: { invocations, cost_usd, duration_ms } }
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }
  // Initiative manifest (initiative_id, project, features). Used by the
  // UI's InitiativeInfo panel so the operator sees what the cycle is
  // actually working on (features, not just IDs). 2026-05-25.
  if (method === 'GET' && url.startsWith('/api/manifest/')) {
    const initiativeId = decodeURIComponent(url.slice('/api/manifest/'.length));
    if (!initiativeId) {
      sendJson(res, 400, { error: 'initiativeId required' });
      return;
    }
    const filename = `${initiativeId}.md`;
    const candidates = [
      join(ctx.queueRoot, 'in-flight', filename),
      join(ctx.queueRoot, 'ready-for-review', filename),
      join(ctx.queueRoot, 'done', filename),
      join(ctx.queueRoot, 'failed', filename),
      join(ctx.queueRoot, 'pending', filename),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      sendJson(res, 404, { error: 'manifest not found in any queue state', initiativeId });
      return;
    }
    try {
      const m = parseManifest(readFileSync(found, 'utf8'));
      sendJson(res, 200, {
        initiativeId: m.initiative_id,
        project: m.project,
        features: m.features.map((f) => ({
          featureId: f.feature_id,
          title: f.title,
          dependsOn: f.depends_on,
        })),
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }
  if (method === 'GET' && url.startsWith('/api/graph/')) {
    const cycleId = decodeURIComponent(url.slice('/api/graph/'.length));
    const filePath = join(ctx.logsRoot, cycleId, 'work-items-snapshot', '_graph.md');
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'no _graph.md for cycle', cycleId });
      return;
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      sendJson(res, 200, { cycleId, mermaid: raw });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }
  // Cycle-scoped artifact (PLAN.md / DEMO.md / etc.). The UI's /plan
  // and /demo sub-pages fetch these so the operator's interaction
  // points (verdict form) link to richer in-app views instead of
  // having to dig into the filesystem.
  // Path normalisation + a startsWith(logsRoot) check defeat
  // ../-escape attempts.
  if (method === 'GET' && url.startsWith('/api/artifact/')) {
    const rest = decodeURIComponent(url.slice('/api/artifact/'.length));
    const slash = rest.indexOf('/');
    if (slash < 0) {
      sendJson(res, 400, { error: 'expected /api/artifact/<cycleId>/<filename>' });
      return;
    }
    const cycleId = rest.slice(0, slash);
    const filename = rest.slice(slash + 1);
    if (!cycleId || !filename) {
      sendJson(res, 400, { error: 'cycleId and filename are required' });
      return;
    }
    const requested = join(ctx.logsRoot, cycleId, 'artifacts', filename);
    const safeBase = join(ctx.logsRoot, cycleId, 'artifacts') + sep;
    if (!requested.startsWith(safeBase)) {
      sendJson(res, 400, { error: 'path escape rejected' });
      return;
    }
    if (!existsSync(requested)) {
      sendJson(res, 404, { error: 'artifact not found', cycleId, filename });
      return;
    }
    try {
      const body = readFileSync(requested, 'utf8');
      res.writeHead(200, {
        'content-type': contentTypeFor(filename),
        'access-control-allow-origin': '*',
      });
      res.end(body);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  // ---- Architect (ADR 020) ----------------------------------------------
  if (await handleArchitect(req, res, ctx, url, method)) return;

  // Scheduler lifecycle.
  if (method === 'GET' && url === '/api/scheduler/status') {
    const state = daemonState(ctx.forgeRoot, ctx.queueRoot);
    sendJson(res, 200, state);
    return;
  }
  if (method === 'POST' && url === '/api/scheduler/start') {
    try {
      const before = daemonState(ctx.forgeRoot, ctx.queueRoot);
      if (before.running) {
        sendJson(res, 200, { ok: true, alreadyRunning: true, state: before });
        return;
      }
      // Spawn detached so the daemon outlives the forge-watch process.
      const proc = spawn(process.execPath, ['--experimental-strip-types', 'orchestrator/cli.ts', 'start'], {
        cwd: ctx.forgeRoot,
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      // Best-effort wait for the pid file to appear.
      await sleep(800);
      const after = daemonState(ctx.forgeRoot, ctx.queueRoot);
      sendJson(res, 200, { ok: true, started: true, state: after });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  // Review verdict — the M2-C intervention surface.
  if (method === 'POST' && url === '/api/verdict') {
    try {
      const body = await readJson(req);
      const { initiativeId, kind, rationale } = body as {
        initiativeId?: string;
        kind?: 'approve' | 'send-back';
        rationale?: string;
        acceptanceCriteria?: Array<{ given: string; when: string; then: string }>;
      };
      if (!initiativeId || !kind || !rationale) {
        sendJson(res, 400, { error: 'initiativeId, kind, rationale required' });
        return;
      }
      if (kind !== 'approve' && kind !== 'send-back') {
        sendJson(res, 400, { error: `unknown kind: ${kind}` });
        return;
      }
      const acs = (body as { acceptanceCriteria?: Array<{ given: string; when: string; then: string }> }).acceptanceCriteria ?? [];
      if (kind === 'send-back' && acs.length === 0) {
        sendJson(res, 400, { error: 'send-back requires at least one acceptanceCriteria' });
        return;
      }
      const paths = fileVerdictPaths(initiativeId, ctx.queueRoot);
      // Accept the verdict for a manifest in EITHER in-flight/ (the
      // reviewer is still iterating, waiting for the verdict file to
      // be picked up) OR ready-for-review/ (closure moved it there
      // because the PR is open / the cap was hit / convergence
      // failed; the verdict file still gets written to in-flight/
      // because that's what the file-verdict reader watches). Without
      // the ready-for-review fallback the UI's verdict form would
      // 409 whenever closure had already run — which is the common
      // case for the journey demo and for any cycle that completed a
      // review iteration before the operator opened the form.
      const inFlightPath = join(ctx.queueRoot, 'in-flight', `${initiativeId}.md`);
      const readyForReviewPath = join(ctx.queueRoot, 'ready-for-review', `${initiativeId}.md`);
      if (!existsSync(inFlightPath) && !existsSync(readyForReviewPath)) {
        sendJson(res, 409, {
          error: 'no manifest for initiative in in-flight/ or ready-for-review/ (already resolved?)',
          initiativeId,
        });
        return;
      }
      const manifestPath = existsSync(inFlightPath) ? inFlightPath : readyForReviewPath;
      // Lock whichever manifest we found so we don't race the scheduler's
      // status transition. proper-lockfile uses a sibling `.lock` dir.
      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(manifestPath, { retries: { retries: 5, minTimeout: 50 } });
      } catch (lockErr) {
        sendJson(res, 503, { error: 'manifest is locked by another writer', detail: String(lockErr) });
        return;
      }
      try {
        const content = renderVerdictResponse(kind, rationale, acs);
        // Write tmp+rename for atomicity (per C16).
        const tmpPath = paths.responsePath + '.tmp';
        mkdirSync(join(ctx.queueRoot, 'in-flight'), { recursive: true });
        writeFileSync(tmpPath, content);
        renameSync(tmpPath, paths.responsePath);
      } finally {
        if (release) { try { await release(); } catch { /* ignore */ } }
      }
      sendJson(res, 200, { ok: true, wrote: paths.responsePath });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

// ---- Architect routes (ADR 020) -------------------------------------------

/** Spawn one architect-runner turn as a detached child (the scheduler-daemon
 *  spawn pattern). Best-effort + fire-and-forget — the runner checkpoints to
 *  the session dir and the fsWatch/`architect-list-changed` signal drives the
 *  UI re-fetch. `FORGE_ARCHITECT_NO_SPAWN=1` disables the spawn for harness /
 *  curl runs that pre-seed session state (mirrors `FORGE_BRIDGE_DEBUG`). */
function spawnArchitectTurn(forgeRoot: string, project: string, sessionId: string): void {
  if (process.env.FORGE_ARCHITECT_NO_SPAWN === '1') return;
  try {
    const proc = spawn(
      process.execPath,
      ['--experimental-strip-types', 'orchestrator/cli.ts', 'architect', 'run', sessionId, '--project', project],
      { cwd: forgeRoot, detached: true, stdio: 'ignore' },
    );
    proc.unref();
  } catch { /* best-effort */ }
}

function architectSessionDir(projectsRoot: string, project: string, sessionId: string): string {
  return join(projectsRoot, project, '_architect', sessionId);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function newArchitectSessionId(): string {
  // YYYY-MM-DDTHH-mm-ss (matches ArchitectSession.session_id elsewhere).
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
}

/** Returns true if the request was an architect route (and was handled). */
async function handleArchitect(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: string,
  method: string,
): Promise<boolean> {
  // GET /api/architect/sessions — list every session with its current state.
  if (method === 'GET' && url === '/api/architect/sessions') {
    const statuses = listArchitectSessions(ctx.projectsRoot);
    const sessions = statuses.map((s) => {
      const dir = architectSessionDir(ctx.projectsRoot, s.project, s.session_id);
      const questions =
        s.phase === 'awaiting-answers'
          ? readJsonFile<ArchitectQuestion[]>(join(dir, 'questions.json'))
          : null;
      const escalations =
        s.phase === 'awaiting-verdict'
          ? readJsonFile<unknown[]>(join(dir, 'escalations.json'))
          : null;
      const planUrl = existsSync(join(dir, 'PLAN.html'))
        ? `/api/architect/file/${encodeURIComponent(s.project)}/${encodeURIComponent(s.session_id)}/PLAN.html`
        : null;
      return {
        sessionId: s.session_id,
        project: s.project,
        projectRepoPath: s.project_repo_path,
        phase: s.phase,
        round: s.round,
        idea: s.idea,
        questions,
        escalations,
        planUrl,
      };
    });
    sendJson(res, 200, { sessions });
    return true;
  }

  // GET /api/architect/file/<project>/<sid>/<filename> — serve a session-dir
  // file (PLAN.html etc.) with a path-escape guard + content-type sniff.
  if (method === 'GET' && url.startsWith('/api/architect/file/')) {
    const rest = url.slice('/api/architect/file/'.length).split('/').map(decodeURIComponent);
    const [project, sessionId, ...fileParts] = rest;
    const filename = fileParts.join('/');
    if (!project || !sessionId || !filename) {
      sendJson(res, 400, { error: 'expected /api/architect/file/<project>/<sid>/<filename>' });
      return true;
    }
    const base = architectSessionDir(ctx.projectsRoot, project, sessionId) + sep;
    const requested = join(architectSessionDir(ctx.projectsRoot, project, sessionId), filename);
    if (!requested.startsWith(base)) {
      sendJson(res, 400, { error: 'path escape rejected' });
      return true;
    }
    if (!existsSync(requested)) {
      sendJson(res, 404, { error: 'file not found', project, sessionId, filename });
      return true;
    }
    try {
      res.writeHead(200, {
        'content-type': contentTypeFor(filename),
        'access-control-allow-origin': '*',
      });
      res.end(readFileSync(requested, 'utf8'));
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/architect/start {project, idea, projectRepoPath?} — create a new
  // session and kick off the first interview turn.
  if (method === 'POST' && url === '/api/architect/start') {
    try {
      const body = (await readJson(req)) as { project?: string; idea?: string; projectRepoPath?: string };
      if (!body.project || !body.idea) {
        sendJson(res, 400, { error: 'project and idea are required' });
        return true;
      }
      const sessionId = newArchitectSessionId();
      const dir = architectSessionDir(ctx.projectsRoot, body.project, sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'idea.md'), body.idea);
      const status: ArchitectStatus = {
        session_id: sessionId,
        project: body.project,
        project_repo_path: body.projectRepoPath ?? join(ctx.projectsRoot, body.project),
        phase: 'interviewing',
        round: 1,
        idea: body.idea,
        updated_at: new Date().toISOString(),
      };
      writeStatus(dir, status);
      spawnArchitectTurn(ctx.forgeRoot, body.project, sessionId);
      ctx.broadcastArchitectChanged();
      sendJson(res, 200, { ok: true, sessionId });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/architect/answer {project, sessionId, answers} — append an
  // interview round and re-spawn a turn.
  if (method === 'POST' && url === '/api/architect/answer') {
    try {
      const body = (await readJson(req)) as {
        project?: string;
        sessionId?: string;
        answers?: { question: string; answer: string }[];
      };
      if (!body.project || !body.sessionId || !Array.isArray(body.answers)) {
        sendJson(res, 400, { error: 'project, sessionId, answers[] are required' });
        return true;
      }
      const dir = architectSessionDir(ctx.projectsRoot, body.project, body.sessionId);
      const status = readStatus(dir);
      if (!status) {
        sendJson(res, 404, { error: 'session not found', sessionId: body.sessionId });
        return true;
      }
      const answersPath = join(dir, 'answers.json');
      const prior = readJsonFile<{ round: number; answers: unknown[] }[]>(answersPath) ?? [];
      const round = prior.length + 1;
      writeFileSync(answersPath, JSON.stringify([...prior, { round, answers: body.answers }], null, 2));
      writeStatus(dir, { ...status, phase: 'interviewing', round: round + 1 });
      spawnArchitectTurn(ctx.forgeRoot, body.project, body.sessionId);
      ctx.broadcastArchitectChanged();
      sendJson(res, 200, { ok: true, round });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // POST /api/plan-verdict {project, sessionId, kind, selections?, rationale?}
  //   approve → write selections + resolved-decisions feedback, finalize turn
  //   revise  → write feedback, re-open the interview
  //   reject  → mark rejected
  if (method === 'POST' && url === '/api/plan-verdict') {
    try {
      const body = (await readJson(req)) as {
        project?: string;
        sessionId?: string;
        kind?: 'approve' | 'revise' | 'reject';
        selections?: Record<string, string>;
        rationale?: string;
      };
      if (!body.project || !body.sessionId || !body.kind) {
        sendJson(res, 400, { error: 'project, sessionId, kind are required' });
        return true;
      }
      if (!['approve', 'revise', 'reject'].includes(body.kind)) {
        sendJson(res, 400, { error: `unknown kind: ${body.kind}` });
        return true;
      }
      const dir = architectSessionDir(ctx.projectsRoot, body.project, body.sessionId);
      const status = readStatus(dir);
      if (!status) {
        sendJson(res, 404, { error: 'session not found', sessionId: body.sessionId });
        return true;
      }

      if (body.kind === 'approve') {
        const selections = body.selections ?? {};
        writeFileSync(join(dir, 'selections.json'), JSON.stringify(selections, null, 2));
        const escalations = readJsonFile<Array<{ id: string; question: string }>>(join(dir, 'escalations.json')) ?? [];
        const lines = ['## Resolved design decisions', ''];
        for (const [id, label] of Object.entries(selections)) {
          const esc = escalations.find((e) => e.id === id);
          lines.push(`- ${esc ? esc.question : id}: **${label}**`);
        }
        if (body.rationale) { lines.push('', body.rationale); }
        writeFileSync(join(dir, 'feedback.md'), lines.join('\n') + '\n');
        writeStatus(dir, { ...status, phase: 'finalizing' });
        spawnArchitectTurn(ctx.forgeRoot, body.project, body.sessionId);
      } else if (body.kind === 'revise') {
        writeFileSync(join(dir, 'feedback.md'), (body.rationale ?? '').trim() + '\n');
        writeStatus(dir, { ...status, phase: 'interviewing', round: status.round + 1 });
        spawnArchitectTurn(ctx.forgeRoot, body.project, body.sessionId);
      } else {
        writeStatus(dir, { ...status, phase: 'rejected' });
      }
      ctx.broadcastArchitectChanged();
      sendJson(res, 200, { ok: true, kind: body.kind });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
}

function renderVerdictResponse(
  kind: 'approve' | 'send-back',
  rationale: string,
  acs: Array<{ given: string; when: string; then: string }>,
): string {
  // Mirrors the shape that orchestrator/file-verdict.ts:parseVerdictResponse
  // expects. YAML frontmatter (`verdict: …` + `rationale: |` block), then
  // optional `- GIVEN ... WHEN ... THEN ...` lines for send-back.
  const fmRationale = rationale.split('\n').map((l) => '  ' + l).join('\n');
  const head = `---\nverdict: ${kind}\nrationale: |\n${fmRationale}\n---\n`;
  if (kind === 'approve') return head;
  const body = acs.map((a) => `- GIVEN ${a.given.trim()} WHEN ${a.when.trim()} THEN ${a.then.trim()}`).join('\n');
  return `${head}\n## Acceptance criteria\n\n${body}\n`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveJson, rejectJson) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolveJson(raw ? JSON.parse(raw) : {}); } catch (err) { rejectJson(err); }
    });
    req.on('error', rejectJson);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(payload);
}

// ---- Tail mechanics --------------------------------------------------------

function pumpTail(state: TailState, emit: (event: EventLogEntry) => void): void {
  try {
    const size = statSync(state.filePath).size;
    if (size <= state.offset) return;
    const chunk = readPartial(state.filePath, state.offset, size);
    state.offset = size;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try { emit(JSON.parse(line) as EventLogEntry); } catch { /* skip malformed */ }
    }
  } catch { /* file rotated / removed */ }
}

function readPartial(filePath: string, from: number, to: number): string {
  const length = to - from;
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, length, from);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}
