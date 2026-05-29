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
  // Present on SDK-backed events (iteration / end). Declared optional so the
  // UI can surface per-agent cost + token totals from the event stream.
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
};

export type BridgeMessage =
  | { type: 'snapshot'; cycles: CycleListSnapshot }
  | { type: 'event'; cycleId: string; event: EventLogEntry }
  | { type: 'cycle-list-changed' }
  | { type: 'architect-list-changed' };

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'no-bridge';

// ---- runtime bridge URL --------------------------------------------------

// Cache the PROMISE rather than the value so concurrent callers
// (Strict Mode double-mount, two effects running on the same tick)
// share a single network request.
let cachedBridgeUrl: Promise<string> | null = null;

/**
 * Build the bridge base URL from `window.location` + the port the
 * server-side API route resolved. Same-hostname-as-the-browser is
 * essential for WSL2 + Windows browser: the Windows browser sees
 * `localhost` (forwarded into WSL by WSL2), while a Linux/WSL browser
 * sees the actual WSL hostname. Either way, the bridge port piggybacks
 * on the same hostname-forwarding the UI port already uses.
 */
export function resolveBridgeUrl(): Promise<string> {
  if (cachedBridgeUrl) return cachedBridgeUrl;
  cachedBridgeUrl = (async () => {
    try {
      const res = await fetch('/api/forge-config', { cache: 'no-store' });
      if (!res.ok) throw new Error(`forge-config → ${res.status}`);
      const body = (await res.json()) as { bridgePort: number | null };
      if (!body.bridgePort) return '';
      // Same hostname as the page so WSL2 (or any other localhost-
      // forwarding scheme) routes the request the same way it routed
      // the UI's HTTP fetch.
      const loc = typeof window !== 'undefined' ? window.location : null;
      if (!loc) return ''; // SSR — client-only code path
      return `${loc.protocol}//${loc.hostname}:${body.bridgePort}`;
    } catch {
      return '';
    }
  })();
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

export type InitiativeFeature = {
  featureId: string;
  title: string;
  dependsOn: string[];
};

export type InitiativeManifestSummary = {
  initiativeId: string;
  project: string;
  features: InitiativeFeature[];
};

/**
 * Fetch the initiative manifest summary (id, project, features). Used by
 * the InitiativeInfo panel so the operator sees what the cycle is
 * actually working on without parsing event metadata. Returns null when
 * the manifest isn't accessible (initiative ID unknown to the bridge,
 * or all queue-state copies are gone).
 */
export async function fetchManifest(initiativeId: string): Promise<InitiativeManifestSummary | null> {
  const base = await resolveBridgeUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/manifest/${encodeURIComponent(initiativeId)}`);
    if (!res.ok) return null;
    return (await res.json()) as InitiativeManifestSummary;
  } catch {
    return null;
  }
}

export type CostSummary = {
  cycleId: string;
  totalUsd: number;
  perPhase: Record<string, { cost_usd: number; iterations: number; duration_ms: number }>;
  perSkill: Record<string, { invocations: number; cost_usd: number; duration_ms: number }>;
};

export async function fetchCost(cycleId: string): Promise<CostSummary | null> {
  const base = await resolveBridgeUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/cost/${encodeURIComponent(cycleId)}`);
    if (!res.ok) return null;
    return (await res.json()) as CostSummary;
  } catch {
    return null;
  }
}

export type SchedulerStatus = {
  running: boolean;
  pid?: number;
  paused?: boolean;
};

export async function fetchSchedulerStatus(): Promise<SchedulerStatus | null> {
  const base = await resolveBridgeUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/scheduler/status`);
    if (!res.ok) return null;
    return (await res.json()) as SchedulerStatus;
  } catch {
    return null;
  }
}

export async function startScheduler(): Promise<{ ok: boolean; error?: string }> {
  const base = await resolveBridgeUrl();
  if (!base) return { ok: false, error: 'no bridge configured' };
  try {
    const res = await fetch(`${base}/api/scheduler/start`, { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: !!body.ok };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type AcceptanceCriterion = { given: string; when: string; then: string };

export type VerdictSubmission =
  | { kind: 'approve'; initiativeId: string; rationale: string }
  | { kind: 'send-back'; initiativeId: string; rationale: string; acceptanceCriteria: AcceptanceCriterion[] };

export async function submitVerdict(input: VerdictSubmission): Promise<{ ok: boolean; error?: string }> {
  const base = await resolveBridgeUrl();
  if (!base) return { ok: false, error: 'no bridge configured' };
  try {
    const res = await fetch(`${base}/api/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: !!body.ok };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---- Structured demo (ADR 021) ------------------------------------------

export type DemoHarnessMetricRow = {
  label: string;
  unit?: string;
  before: string | null;
  after: string | null;
  deltaPct: number | null;
  parity: 'match' | 'within' | 'diverged' | 'incomplete';
};

export type DemoModelCheckpoint = {
  label: string;
  kind?: 'screenshot' | 'video' | 'harness';
  caption: string;
  beforeNote?: string;
  afterNote?: string;
  metrics?: DemoHarnessMetricRow[];
  beforeImage?: string | null;
  afterImage?: string | null;
};

export type DemoModel = {
  title: string;
  essence: string;
  project: string;
  initiativeId?: string;
  baseRef?: string;
  changedRef?: string;
  checkpoints: DemoModelCheckpoint[];
  diffStat: string;
  acceptanceCriteria?: string[];
};

/** Fetch the cycle's structured demo (mirrored into _logs/<cycle>/artifacts/
 *  by snapshotCycleArtefacts). Returns null when absent or unparseable. */
export async function fetchDemoModel(cycleId: string): Promise<DemoModel | null> {
  const base = await resolveBridgeUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/artifact/${encodeURIComponent(cycleId)}/demo.json`);
    if (!res.ok) return null;
    return (await res.json()) as DemoModel;
  } catch {
    return null;
  }
}

// ---- Architect (ADR 020) -------------------------------------------------

export type ArchitectPhase =
  | 'interviewing'
  | 'awaiting-answers'
  | 'drafting'
  | 'awaiting-verdict'
  | 'finalizing'
  | 'committed'
  | 'rejected';

export type ArchitectQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
};

export type ArchitectEscalation = {
  id: string;
  critic: string;
  question: string;
  options: { label: string; rationale: string }[];
};

export type ArchitectSessionSummary = {
  sessionId: string;
  project: string;
  projectRepoPath: string;
  phase: ArchitectPhase;
  round: number;
  idea: string;
  questions: ArchitectQuestion[] | null;
  escalations: ArchitectEscalation[] | null;
  planUrl: string | null;
};

export async function fetchArchitectSessions(): Promise<ArchitectSessionSummary[]> {
  const base = await resolveBridgeUrl();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/architect/sessions`);
    if (!res.ok) return [];
    const body = (await res.json()) as { sessions: ArchitectSessionSummary[] };
    return body.sessions ?? [];
  } catch {
    return [];
  }
}

/** Absolutise a bridge-relative `planUrl` (e.g. `/api/architect/file/...`) for
 *  an iframe `src`. Returns '' when no bridge is configured. */
export async function architectFileUrl(relative: string): Promise<string> {
  const base = await resolveBridgeUrl();
  return base ? `${base}${relative}` : '';
}

export async function startArchitect(input: {
  project: string;
  idea: string;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const base = await resolveBridgeUrl();
  if (!base) return { ok: false, error: 'no bridge configured' };
  try {
    const res = await fetch(`${base}/api/architect/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { ok?: boolean; sessionId?: string; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: !!body.ok, sessionId: body.sessionId };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function postArchitectAnswers(input: {
  project: string;
  sessionId: string;
  answers: { question: string; answer: string }[];
}): Promise<{ ok: boolean; error?: string }> {
  const base = await resolveBridgeUrl();
  if (!base) return { ok: false, error: 'no bridge configured' };
  try {
    const res = await fetch(`${base}/api/architect/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: !!body.ok };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type PlanVerdict = {
  project: string;
  sessionId: string;
  kind: 'approve' | 'revise' | 'reject';
  selections?: Record<string, string>;
  rationale?: string;
};

export async function postPlanVerdict(input: PlanVerdict): Promise<{ ok: boolean; error?: string }> {
  const base = await resolveBridgeUrl();
  if (!base) return { ok: false, error: 'no bridge configured' };
  try {
    const res = await fetch(`${base}/api/plan-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: !!body.ok };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---- WebSocket subscription ---------------------------------------------

export type Subscription = { close: () => void };

export type SubscribeHandlers = {
  onMessage: (msg: BridgeMessage) => void;
  onState?: (state: ConnectionState) => void;
};

export function subscribe(handlers: SubscribeHandlers): Subscription {
  // `socket` is the CURRENT live socket. `closed` flips when the
  // consumer cancels the subscription; once true, no new sockets are
  // created and any in-flight `connect()` aborts after its await.
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  let connecting = false; // serialises connect() against itself
  const setState = (s: ConnectionState): void => handlers.onState?.(s);

  const connect = async (): Promise<void> => {
    if (closed || connecting) return;
    connecting = true;
    try {
      const base = await resolveBridgeUrl();
      // CRITICAL: between subscribe() returning and the await above
      // resolving, the consumer (e.g., React Strict Mode cleanup) may
      // have called close(). Re-check before creating a socket — without
      // this, every dev-mode mount leaks a WS that survives the cleanup.
      if (closed) return;
      if (!base) {
        setState('no-bridge');
        setTimeout(() => { clearBridgeCache(); void connect(); }, 2000);
        return;
      }
      setState('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
      } catch {
        setState('reconnecting');
        setTimeout(() => { void connect(); }, backoff);
        backoff = Math.min(backoff * 2, 5000);
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (closed) { try { ws.close(); } catch { /* */ } return; }
        backoff = 500;
        setState('open');
      };
      ws.onmessage = (ev) => {
        if (closed) return;
        try { handlers.onMessage(JSON.parse(ev.data)); } catch { /* malformed */ }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (closed) return;
        setState('reconnecting');
        setTimeout(() => { void connect(); }, backoff);
        backoff = Math.min(backoff * 2, 5000);
      };
      ws.onerror = () => {
        try { ws.close(); } catch { /* already closed */ }
      };
    } finally {
      connecting = false;
    }
  };

  void connect();

  return {
    close: () => {
      closed = true;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
    },
  };
}
