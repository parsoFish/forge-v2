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
  | { type: 'cycle-list-changed' };

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

  const clients = new Set<WebSocket>();
  const tails = new Map<string, TailState>();
  const queueWatchers: FSWatcher[] = [];

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

  const http = createServer((req, res) => {
    void handleHttp(req, res, {
      scanCycles,
      logsRoot,
      forgeRoot,
      queueRoot: queuePaths.root,
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

  const close = async (): Promise<void> => {
    for (const w of queueWatchers) { try { w.close(); } catch { /* ignore */ } }
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
};

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
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(body);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

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
      const manifestPath = join(ctx.queueRoot, 'in-flight', `${initiativeId}.md`);
      if (!existsSync(manifestPath)) {
        sendJson(res, 409, { error: 'no in-flight manifest for initiative (already resolved?)', initiativeId });
        return;
      }
      // Lock the in-flight manifest so we don't race the scheduler's
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
