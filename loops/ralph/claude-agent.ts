/**
 * Claude Agent SDK adapter for the Ralph loop.
 *
 * Provides `createClaudeAgent(opts)` which returns an `AgentInvocation` (the
 * shape `runner.ts` expects). One call ≈ one Ralph iteration: read PROMPT.md,
 * call the SDK's `query()` against the worktree, surface files-changed via
 * tool_use events and cost via the final `result` message.
 *
 * The SDK's `query` is dependency-injectable (`opts.queryFn`) so unit tests
 * can verify the glue without hitting the network.
 *
 * Wired per ADR 001 (Claude Agent SDK) and ADR 002 (Ralph loop pattern).
 */

import { readFileSync, existsSync } from 'node:fs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { AgentInvocation, ToolUseDetail } from './runner.ts';

/** Subset of the SDK's `query` shape we depend on — keeps the tests independent of SDK internals. */
export type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type ClaudeAgentOptions = {
  /** e.g. 'claude-sonnet-4-6'. Defaults to the SDK's CLI default. */
  model?: string;
  /** Tool allowlist. Defaults to the read/write/exec set Ralph needs. */
  allowedTools?: string[];
  /** Tool denylist. SDK treats this as "block even if allowedTools includes it". */
  disallowedTools?: string[];
  /** Cap turns per iteration (one Ralph iteration = one query() call). */
  maxTurnsPerIteration?: number;
  /** Cap USD spend per iteration. */
  maxBudgetUsdPerIteration?: number;
  /** SDK permission mode. Defaults to 'acceptEdits' for unattended operation. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  /** Optional system-prompt override. */
  systemPrompt?: string;
  /**
   * S8 / C23 — prompt caching opt-in. Defaults to `true`. The Claude Agent
   * SDK v0.1.0 does NOT expose an explicit `cache_control` marker on its
   * public API surface — caching happens server-side inside the Claude Code
   * CLI subprocess, keyed on prompt stability. This flag carries forge's
   * intent forward: when the SDK later exposes a marker, plumbing already
   * exists. For today, leaving it `true` documents that callers SHOULD keep
   * their system prompts stable (no per-iteration timestamps mid-prompt).
   *
   * Cache hit telemetry IS already surfaced: see the `cacheReadTokens` /
   * `cacheCreationTokens` fields on the return value, populated from the
   * SDK's `result.usage.cache_read_input_tokens` /
   * `cache_creation_input_tokens` fields.
   *
   * TTL: the CLI uses ephemeral (5-min) by default — adequate for the
   * dev/review Ralph hot loops where iterations cluster within a single
   * cycle.
   */
  cacheable?: boolean;
  /** Inject a fake `query` for testing. */
  queryFn?: QueryFn;
  /**
   * S7 / C13 — sidecar heartbeat callback. When provided, the agent
   * starts a `setInterval` BEFORE the SDK `query()` is awaited and clears
   * it on the result. The callback receives `{ tool_use_count, last_tool,
   * since_ms }`. Plumbed through to a JSONL `agent_heartbeat` event by
   * the runner (which owns the cycle's logger reference).
   *
   * If unset, no heartbeats fire — the dev-loop runner / review-loop
   * runner is responsible for wiring this in production. Tests pass
   * `onHeartbeat` directly to assert the timer behaviour.
   */
  onHeartbeat?: (info: HeartbeatInfo) => void;
  /**
   * Phase A (UI live telemetry) — fired once per `tool_use` block observed in
   * the SDK stream, BEFORE the tool result returns. Lets the orchestrator emit
   * per-tool `tool_use` / `file_change` JSONL events (sampled) so the operator
   * UI can pulse the active agent node live, instead of only at iteration end.
   *
   * `seq` is the 1-based per-iteration sequence (one `query()` call = one
   * iteration), so a sampler keyed on `seq` resets naturally each iteration.
   * Never lets a misbehaving sink kill the SDK call (wrapped in try/catch).
   * If unset, no per-tool events fire — backward compatible.
   */
  onToolUse?: (detail: ToolUseLiveDetail) => void;
  /**
   * S7 / C13 — heartbeat cadence in ms. Default 15_000 (15s). Read from
   * the project config's `logging.heartbeat_seconds` by callers; here we
   * accept the resolved value so this module stays config-agnostic.
   */
  heartbeatIntervalMs?: number;
  /**
   * S7 / C13 — idle threshold for the tail-emit. Default 30_000 (30s).
   * If the SDK call takes longer than this AND no heartbeat has fired
   * for that span (e.g. the timer was masked or skipped), one extra
   * "idle" heartbeat is forced when the result arrives so the operator
   * sees the silent stretch in the log.
   */
  heartbeatIdleTailMs?: number;
  /**
   * Inject a fake setInterval / clearInterval / Date.now for tests.
   * Defaults to `globalThis.*`. Lets the heartbeat test mock the timer
   * without hooking the real event loop.
   */
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
    now: () => number;
  };
};

/**
 * S7 / C13 — payload of one agent_heartbeat metadata block. The runner
 * adapts this into an `EventLogEntry` row via the project's logger.
 */
export type HeartbeatInfo = {
  /** Number of tool_use blocks observed since `query()` started. */
  tool_use_count: number;
  /** Name of the most recently observed tool (`Bash`, `Read`, …) or `''`. */
  last_tool: string;
  /** Elapsed wall time in ms since `query()` was invoked. */
  since_ms: number;
};

/**
 * Phase A — payload of one live `onToolUse` callback. Carries enough to emit
 * both a `tool_use` event (name + input summary) and, for file-modifying
 * tools, a `file_change` event (path + op). `op` is best-effort: `add` vs
 * `modify` is inferred from whether the path exists at observation time.
 */
export type ToolUseLiveDetail = {
  name: string;
  inputSummary: string;
  /** Present only for file-modifying tools (Write/Edit/MultiEdit/NotebookEdit). */
  filePath?: string;
  op?: 'add' | 'modify' | 'delete';
  /** 1-based per-iteration sequence (== tool_use count at time of call). */
  seq: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_IDLE_TAIL_MS = 30_000;

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob'];
export const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function createClaudeAgent(opts: ClaudeAgentOptions = {}): AgentInvocation {
  const queryFn: QueryFn = opts.queryFn ?? (sdkQuery as unknown as QueryFn);

  return async ({ promptPath, worktreePath }) => {
    const prompt = readFileSync(promptPath, 'utf8');

    const options: Record<string, unknown> = {
      cwd: worktreePath,
      allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      permissionMode: opts.permissionMode ?? 'acceptEdits',
      // S8 / C23 — see ClaudeAgentOptions.cacheable. The SDK does not (yet)
      // consume this; it's forge-intent forwarded for downstream wiring +
      // observability. cache_control: { type: 'ephemeral' } is the eventual
      // marker shape per the Anthropic API; the SDK abstracts it today.
      cacheable: opts.cacheable ?? true,
    };
    if (opts.disallowedTools !== undefined) options.disallowedTools = opts.disallowedTools;
    if (opts.model !== undefined) options.model = opts.model;
    if (opts.maxTurnsPerIteration !== undefined) options.maxTurns = opts.maxTurnsPerIteration;
    if (opts.maxBudgetUsdPerIteration !== undefined) options.maxBudgetUsd = opts.maxBudgetUsdPerIteration;
    if (opts.systemPrompt !== undefined) options.systemPrompt = opts.systemPrompt;

    const filesChanged = new Set<string>();
    let costUsd = 0;
    // F-23: per-iteration observability — capture what the agent actually did.
    const toolsUsed: ToolUseDetail[] = [];
    const bashCommands: string[] = [];
    let lastAssistantText = '';
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    // S8 / C23 — cache-hit telemetry. Underlying API uses snake_case
    // (cache_read_input_tokens / cache_creation_input_tokens) on the `usage`
    // block of the result message; we surface camelCase to match the rest of
    // this adapter and snake_case again in the JSONL event entry (matching
    // existing `cost_usd / tokens_in / tokens_out` convention).
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    // S7 / C13 — heartbeat sidecar state. `lastTool` mutates as the SDK
    // stream yields tool_use blocks; the timer reads it without locking
    // (single-threaded JS).
    let toolUseCount = 0;
    let lastTool = '';
    let lastHeartbeatAt = 0;
    let heartbeatHandle: unknown = null;

    const timers = opts.timers ?? {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
      now: () => Date.now(),
    };
    const intervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const idleTailMs = opts.heartbeatIdleTailMs ?? DEFAULT_HEARTBEAT_IDLE_TAIL_MS;
    const queryStartedAt = timers.now();
    if (opts.onHeartbeat) {
      heartbeatHandle = timers.setInterval(() => {
        const now = timers.now();
        try {
          opts.onHeartbeat!({
            tool_use_count: toolUseCount,
            last_tool: lastTool,
            since_ms: now - queryStartedAt,
          });
        } catch {
          /* never let a misbehaving heartbeat sink kill the SDK call */
        }
        lastHeartbeatAt = now;
      }, intervalMs);
    }

    for await (const msg of queryFn({ prompt, options })) {
      const m = msg as { type?: string };
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; name?: string; input?: unknown; text?: string };
            if (b.type === 'text' && typeof b.text === 'string') {
              // Last text block wins — typically the agent's final reasoning.
              lastAssistantText = b.text;
              continue;
            }
            if (b.type !== 'tool_use' || !b.name) continue;
            // S7 / C13 — heartbeat sees every tool_use; counter advances
            // even when the tool doesn't mutate files.
            toolUseCount += 1;
            lastTool = b.name;
            // Capture every tool_use, not just file-modifying ones, for the
            // observability log.
            toolsUsed.push({ name: b.name, inputSummary: summarizeToolInput(b.name, b.input) });
            if (FILE_MODIFYING_TOOLS.has(b.name)) {
              const path = extractPath(b.input);
              if (path) filesChanged.add(path);
            }
            if (b.name === 'Bash') {
              const cmd = extractBashCommand(b.input);
              if (cmd) bashCommands.push(truncate(cmd, 200));
            }
            // Phase A — live per-tool telemetry. Fire BEFORE the tool result so
            // the UI can pulse the node mid-iteration. Best-effort; never throws
            // into the SDK stream.
            if (opts.onToolUse) {
              const fc = fileChangeForTool(b.name, b.input);
              try {
                opts.onToolUse({
                  name: b.name,
                  inputSummary: summarizeToolInput(b.name, b.input),
                  filePath: fc?.filePath,
                  op: fc?.op,
                  seq: toolUseCount,
                });
              } catch {
                /* never let a misbehaving tool-use sink kill the SDK call */
              }
            }
          }
        }
      } else if (m.type === 'result') {
        const r = m as {
          total_cost_usd?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        if (typeof r.total_cost_usd === 'number') costUsd = r.total_cost_usd;
        if (r.usage) {
          if (typeof r.usage.input_tokens === 'number') tokensIn = r.usage.input_tokens;
          if (typeof r.usage.output_tokens === 'number') tokensOut = r.usage.output_tokens;
          if (typeof r.usage.cache_read_input_tokens === 'number') {
            cacheReadTokens = r.usage.cache_read_input_tokens;
          }
          if (typeof r.usage.cache_creation_input_tokens === 'number') {
            cacheCreationTokens = r.usage.cache_creation_input_tokens;
          }
        }
      }
    }

    // S7 / C13 — sidecar shutdown. Always clear the interval, then check
    // the idle-tail invariant: if the SDK call took ≥ idleTailMs AND no
    // heartbeat has fired in the last idleTailMs span, force one final
    // emit so the operator's log shows the silent stretch even when the
    // interval timer was masked (e.g. event-loop saturation, mocked
    // timers that didn't advance, etc.).
    if (heartbeatHandle !== null) {
      timers.clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    if (opts.onHeartbeat) {
      const now = timers.now();
      const elapsed = now - queryStartedAt;
      const sinceLast = lastHeartbeatAt === 0 ? elapsed : now - lastHeartbeatAt;
      if (elapsed >= idleTailMs && sinceLast >= idleTailMs) {
        try {
          opts.onHeartbeat({
            tool_use_count: toolUseCount,
            last_tool: lastTool,
            since_ms: elapsed,
          });
        } catch {
          /* swallow */
        }
      }
    }

    return {
      filesChanged: [...filesChanged],
      costUsd,
      toolsUsed,
      bashCommands,
      lastAssistantText: truncate(lastAssistantText, 2000),
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheCreationTokens,
    };
  };
}

function extractPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.notebook_path ?? obj.path;
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * Phase A — derive a `{ filePath, op }` file-change descriptor for a tool call,
 * or `null` if the tool doesn't mutate a file. `op` is best-effort: Edit-family
 * tools imply the file pre-exists (`modify`); a `Write` to a path that doesn't
 * exist yet is an `add`, otherwise a `modify`. Shared by the live stream loop
 * here and the PM's own stream loop via `tool-event-emit.ts`.
 */
export function fileChangeForTool(
  name: string,
  input: unknown,
): { filePath: string; op: 'add' | 'modify' | 'delete' } | null {
  if (!FILE_MODIFYING_TOOLS.has(name)) return null;
  const filePath = extractPath(input);
  if (!filePath) return null;
  let op: 'add' | 'modify' | 'delete' = 'modify';
  if (name === 'Write') {
    op = existsSync(filePath) ? 'modify' : 'add';
  }
  return { filePath, op };
}

function extractBashCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : null;
}

/**
 * Render a short identifier for a tool call. For file ops, the path is the
 * most useful summary; for Bash, the truncated command; otherwise a JSON blob
 * truncated to 200 chars. Goal: enough to grep an event log post-hoc, not so
 * much that a wedged loop inflates events.jsonl unbounded.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input === null || input === undefined) return '';
  if (name === 'Bash') {
    const cmd = extractBashCommand(input);
    return cmd ? truncate(cmd, 200) : '';
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit' || name === 'Glob') {
    const path = extractPath(input);
    if (path) return truncate(path, 200);
  }
  if (name === 'Grep') {
    const obj = input as { pattern?: unknown; path?: unknown };
    const pattern = typeof obj.pattern === 'string' ? obj.pattern : '';
    const path = typeof obj.path === 'string' ? obj.path : '';
    return truncate(path ? `${pattern} @ ${path}` : pattern, 200);
  }
  try {
    return truncate(JSON.stringify(input), 200);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
