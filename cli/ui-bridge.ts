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
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { getPaths, listInFlight } from '../orchestrator/queue.ts';
import { parseManifest } from '../orchestrator/manifest.ts';
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

export function startBridge(opts: BridgeOptions): { url: string; close: () => Promise<void> } {
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
    const live: Cycle[] = [];
    const recent: Cycle[] = [];

    // Live = in-flight + ready-for-review.
    for (const name of listInFlight(queuePaths)) {
      const id = name.replace(/\.md$/, '');
      const manifestPath = join(queuePaths.inFlight, name);
      let project: string | undefined;
      try { project = parseManifest(readFileSync(manifestPath, 'utf8')).project; } catch { /* ignore */ }
      // listInFlight returns filenames; the in-flight manifest's name
      // carries the initiative ID. The actual cycle ID (a timestamp+id
      // string) lives under _logs/<cycleId>/. The UI resolves the active
      // cycle for an initiative through the live event stream
      // (initiative_id is in every event).
      live.push({ cycleId: id, initiativeId: id, project, status: 'in-flight' });
    }
    if (existsSync(queuePaths.readyForReview)) {
      for (const name of readdirSync(queuePaths.readyForReview)) {
        if (!name.endsWith('.md')) continue;
        const id = name.replace(/\.md$/, '');
        const manifestPath = join(queuePaths.readyForReview, name);
        let project: string | undefined;
        try { project = parseManifest(readFileSync(manifestPath, 'utf8')).project; } catch { /* ignore */ }
        live.push({ cycleId: id, initiativeId: id, project, status: 'ready-for-review' });
      }
    }

    // Recent = last RECENT_CYCLES_MAX of done/ + failed/ by mtime.
    const recentCandidates: Array<{ cycle: Cycle; mtime: number }> = [];
    for (const [dir, status] of [
      [queuePaths.done, 'done' as const],
      [queuePaths.failed, 'failed' as const],
    ] as const) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const fullPath = join(dir, name);
        let mtime = 0;
        let project: string | undefined;
        try {
          mtime = statSync(fullPath).mtimeMs;
          project = parseManifest(readFileSync(fullPath, 'utf8')).project;
        } catch { /* ignore */ }
        const id = name.replace(/\.md$/, '');
        recentCandidates.push({
          cycle: { cycleId: id, initiativeId: id, project, status },
          mtime,
        });
      }
    }
    recentCandidates.sort((a, b) => b.mtime - a.mtime);
    for (const { cycle } of recentCandidates.slice(0, RECENT_CYCLES_MAX)) {
      recent.push(cycle);
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

  const http = createServer((req, res) => handleHttp(req, res, { scanCycles, logsRoot }));
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

  http.listen(port);
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

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { scanCycles: () => { live: Cycle[]; recent: Cycle[] }; logsRoot: string },
): void {
  const url = req.url ?? '/';
  if (url === '/api/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url === '/api/cycles') {
    sendJson(res, 200, ctx.scanCycles());
    return;
  }
  if (url.startsWith('/api/events/')) {
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
  res.writeHead(404);
  res.end();
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
