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

import { readFileSync } from 'node:fs';
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
};

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob'];
const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

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
function summarizeToolInput(name: string, input: unknown): string {
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
