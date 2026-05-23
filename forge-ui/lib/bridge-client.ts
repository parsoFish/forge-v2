/**
 * Client-side glue to the forge-ui-bridge.
 *
 * Two concerns:
 *   1. Resolve the bridge URL (forwarded by `forge watch` via FORGE_BRIDGE_URL
 *      env var, surfaced to the browser via next.config.mjs `env`).
 *   2. Open a single WebSocket connection on /ws and dispatch incoming
 *      messages to subscribers.
 *
 * Keeps the React side out of websocket plumbing — components just call
 * subscribe() with a handler.
 */

export type Cycle = {
  cycleId: string;
  initiativeId: string;
  project?: string;
  status: 'in-flight' | 'ready-for-review' | 'done' | 'failed' | 'pending';
  startedAt?: string;
  endedAt?: string;
};

export type CycleListSnapshot = { live: Cycle[]; recent: Cycle[] };

export type EventLogEntry = {
  event_id: string;
  cycle_id?: string;
  initiative_id: string;
  started_at: string;
  phase: string;
  skill: string;
  event_type: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type BridgeMessage =
  | { type: 'snapshot'; cycles: CycleListSnapshot }
  | { type: 'event'; cycleId: string; event: EventLogEntry }
  | { type: 'cycle-list-changed' };

export function getBridgeBase(): string {
  // Next.js exposes process.env.FORGE_BRIDGE_URL to the client at build time
  // (per next.config.mjs env block). When watch starts Next.js it sets this.
  const fromEnv = process.env.FORGE_BRIDGE_URL || '';
  if (fromEnv) return fromEnv;
  // Fallback for raw `next dev` without `forge watch` (developer convenience):
  // try the default bridge port.
  return 'http://127.0.0.1:4123';
}

export function getBridgeWsUrl(): string {
  const base = getBridgeBase();
  return base.replace(/^http/, 'ws') + '/ws';
}

export async function fetchCycles(): Promise<CycleListSnapshot> {
  const res = await fetch(`${getBridgeBase()}/api/cycles`);
  if (!res.ok) throw new Error(`bridge /api/cycles → ${res.status}`);
  return res.json();
}

export async function fetchEvents(cycleId: string): Promise<EventLogEntry[]> {
  const res = await fetch(`${getBridgeBase()}/api/events/${encodeURIComponent(cycleId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { events: EventLogEntry[] };
  return body.events;
}

export type Subscription = { close: () => void };

export function subscribe(onMessage: (msg: BridgeMessage) => void): Subscription {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(getBridgeWsUrl());
    socket.onopen = () => { backoff = 500; };
    socket.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
    };
    socket.onclose = () => {
      socket = null;
      if (!closed) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    };
    socket.onerror = () => {
      try { socket?.close(); } catch { /* already closed */ }
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      try { socket?.close(); } catch { /* ignore */ }
    },
  };
}
