/**
 * Client-side glue to the forge-ui-bridge.
 *
 * Bridge URL discovery is RUNTIME: the client fetches /api/forge-config
 * (a Next.js route that reads process.env.FORGE_BRIDGE_URL at request
 * time). This avoids the build-time embedding fragility of next.config
 * `env` blocks across `forge watch` restarts.
 *
 * One subscribe() opens a single WebSocket; the page is expected to
 * call this once for the lifetime of the mount. Cycle-selection filtering
 * lives in the handler the page provides — the bridge broadcasts events
 * for every live cycle.
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

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'no-bridge';

// ---- runtime bridge URL --------------------------------------------------

let cachedBridgeUrl: string | null = null;

export async function resolveBridgeUrl(): Promise<string> {
  if (cachedBridgeUrl !== null) return cachedBridgeUrl;
  try {
    const res = await fetch('/api/forge-config', { cache: 'no-store' });
    if (!res.ok) throw new Error(`forge-config → ${res.status}`);
    const body = (await res.json()) as { bridgeUrl: string };
    cachedBridgeUrl = body.bridgeUrl;
  } catch {
    cachedBridgeUrl = '';
  }
  return cachedBridgeUrl;
}

function clearBridgeCache(): void {
  cachedBridgeUrl = null;
}

// ---- HTTP API ------------------------------------------------------------

export async function fetchCycles(): Promise<CycleListSnapshot> {
  const base = await resolveBridgeUrl();
  if (!base) throw new Error('no bridge configured');
  const res = await fetch(`${base}/api/cycles`);
  if (!res.ok) throw new Error(`bridge /api/cycles → ${res.status}`);
  return res.json();
}

export async function fetchEvents(cycleId: string): Promise<EventLogEntry[]> {
  const base = await resolveBridgeUrl();
  if (!base) return [];
  const res = await fetch(`${base}/api/events/${encodeURIComponent(cycleId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { events: EventLogEntry[] };
  return body.events;
}

// ---- WebSocket subscription ---------------------------------------------

export type Subscription = { close: () => void };

export type SubscribeHandlers = {
  onMessage: (msg: BridgeMessage) => void;
  onState?: (state: ConnectionState) => void;
};

export function subscribe(handlers: SubscribeHandlers): Subscription {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  const setState = (s: ConnectionState): void => handlers.onState?.(s);

  const connect = async (): Promise<void> => {
    if (closed) return;
    const base = await resolveBridgeUrl();
    if (!base) {
      setState('no-bridge');
      // Try again later — maybe the bridge isn't up yet.
      setTimeout(() => { clearBridgeCache(); void connect(); }, 2000);
      return;
    }
    setState('connecting');
    try {
      socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    } catch {
      setState('reconnecting');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
      return;
    }
    socket.onopen = () => {
      backoff = 500;
      setState('open');
    };
    socket.onmessage = (ev) => {
      try { handlers.onMessage(JSON.parse(ev.data)); } catch { /* malformed */ }
    };
    socket.onclose = () => {
      socket = null;
      if (closed) return;
      setState('reconnecting');
      setTimeout(() => { void connect(); }, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    socket.onerror = () => {
      try { socket?.close(); } catch { /* already closed */ }
    };
  };

  void connect();

  return {
    close: () => {
      closed = true;
      try { socket?.close(); } catch { /* ignore */ }
    },
  };
}
