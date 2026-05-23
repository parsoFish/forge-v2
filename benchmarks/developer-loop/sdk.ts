/**
 * SDK invocation helper for the developer-loop benchmark.
 *
 * One call ≈ one Ralph loop run against one fixture. Sets up an isolated
 * tempdir, copies the fixture's seed worktree into `projects/<name>/`, drops
 * the WI spec into `<worktree>/.forge/work-items/`, builds a per-fixture
 * quality-gate function, and invokes `loops/ralph/runner.ts:run()` with the
 * Claude Agent SDK adapter.
 *
 * Why isolated tempdirs (vs running against the live repo): each fixture
 * mutates its worktree (the agent edits files), and the bench must produce
 * deterministic, comparable runs. Symlinks make brain/, skills/, docs/,
 * orchestrator/, loops/ available to the agent without copying.
 *
 * Why a per-fixture quality gate: fixtures are multi-language (Python /
 * TypeScript / bash). The runner's default quality gate hard-codes
 * `npm test`; the bench injects pytest / bats / node:test commands instead.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, relative } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  DEV_ALLOWED_TOOLS,
  DEV_DISALLOWED_TOOLS,
  DEV_MODEL,
  buildDevSystemPrompt,
  prepareDevWorkspace,
  tallyToolUse,
  type DevToolUseSummary,
} from '../../orchestrator/dev-invocation.ts';
import { createClaudeAgent, type QueryFn } from '../../loops/ralph/claude-agent.ts';
import { run, type LoopInput, type LoopResult } from '../../loops/ralph/runner.ts';
import { type WorkItem } from '../../orchestrator/work-item.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

export type DevQueryFn = QueryFn;

export type RunDevInput = {
  fixtureId: string;
  initiativeId: string;
  /**
   * Absolute path to the fixture's seed tree (a directory under
   * benchmarks/developer-loop/fixtures/<id>/). Copied recursively into
   * <tempdir>/projects/<projectName>/.
   */
  seedTreePath: string;
  projectName: string;
  /** Worktree-relative path to the WI spec inside the seed tree, e.g. `.forge/work-items/WI-1.md`. */
  workItemSpecRelPath: string;
  expected: {
    max_iterations: number;
    /**
     * S4: per CONTRACTS.md C19 the dev-loop bench has no $-cap criterion;
     * this field is retained for back-compat in fixture parsing and used
     * only as a soft per-iteration cap inside this sdk module (never as a
     * pass/fail signal). Optional; defaults to Infinity when omitted.
     */
    max_cost_usd?: number;
    quality_gate_cmd: string[];
    pre_existing_tests_cmd?: string[];
  };
  /** Inject a fake `query` for testing. */
  queryFn?: DevQueryFn;
};

export type DevRunnerErrorKind =
  | 'spec_missing'
  | 'spec_parse_error'
  | 'agent_threw'
  | 'unknown_error';

export type RunDevResult = {
  result: LoopResult | null;
  workItem: WorkItem | null;
  tempdir: string;
  worktreePath: string;
  workItemSpecPath: string;
  durationMs: number;
  costUsd: number;
  toolUseSummary: DevToolUseSummary;
  regressionPassed: boolean;
  runnerError?: { kind: DevRunnerErrorKind; message: string };
};

export function setupTempdir(input: RunDevInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-dev-'));

  for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
    symlinkSync(resolve(FORGE_ROOT, sub), resolve(dir, sub));
  }

  const projDir = resolve(dir, 'projects', input.projectName);
  mkdirSync(projDir, { recursive: true });

  if (!existsSync(input.seedTreePath)) {
    throw new Error(`seed tree path does not exist: ${input.seedTreePath}`);
  }
  cpSync(input.seedTreePath, projDir, { recursive: true });

  return dir;
}

export function cleanupTempdir(tempdir: string): void {
  try {
    rmSync(tempdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Build a quality-gate function the runner calls between iterations.
 * Returns true when the named command exits 0 in the worktree.
 */
export function makeQualityGate(worktreePath: string, cmd: string[]): () => boolean {
  if (cmd.length === 0) {
    throw new Error('quality_gate_cmd must have at least one argv element');
  }
  return () => runCommand(worktreePath, cmd);
}

function runCommand(cwd: string, cmd: string[]): boolean {
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise a path reported by the SDK adapter (which may be absolute or
 * relative to the agent's cwd) to a worktree-relative path. Returns null if
 * the path is outside the worktree (filtered out before scoring).
 */
export function worktreeRelative(p: string, worktreePath: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(worktreePath, p);
  const rel = relative(worktreePath, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}

export async function runDevLoop(input: RunDevInput): Promise<RunDevResult> {
  const tempdir = setupTempdir(input);
  const worktreePath = resolve(tempdir, 'projects', input.projectName);
  const workItemSpecPath = resolve(worktreePath, input.workItemSpecRelPath);

  const toolUseSummary: DevToolUseSummary = { reads: 0, brainReads: 0, writes: 0, bashCalls: 0, testRuns: 0 };

  if (!existsSync(workItemSpecPath)) {
    return {
      result: null,
      workItem: null,
      tempdir,
      worktreePath,
      workItemSpecPath,
      durationMs: 0,
      costUsd: 0,
      toolUseSummary,
      regressionPassed: false,
      runnerError: {
        kind: 'spec_missing',
        message: `WI spec not found at ${workItemSpecPath}`,
      },
    };
  }

  let workItem: WorkItem;
  try {
    const prepared = prepareDevWorkspace({
      initiativeId: input.initiativeId,
      workItemSpecPath,
      workItemSpecRelPath: input.workItemSpecRelPath,
      worktreePath,
      iterationBudget: input.expected.max_iterations,
      // S4: per C19 there is no $-cap. Use Infinity so the prompt header
      // shows "no $ ceiling".
      costBudgetUsd: input.expected.max_cost_usd ?? Number.POSITIVE_INFINITY,
    });
    workItem = prepared.workItem;
  } catch (err) {
    return {
      result: null,
      workItem: null,
      tempdir,
      worktreePath,
      workItemSpecPath,
      durationMs: 0,
      costUsd: 0,
      toolUseSummary,
      regressionPassed: false,
      runnerError: {
        kind: 'spec_parse_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const queryFn: DevQueryFn = input.queryFn ?? (sdkQuery as unknown as DevQueryFn);

  // Wrap the queryFn so we can tally tool-use as the agent streams.
  const tallyingQueryFn: DevQueryFn = ({ prompt, options }) => {
    const inner = queryFn({ prompt, options });
    return (async function* () {
      for await (const msg of inner) {
        const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } };
        if (m.type === 'assistant') {
          tallyToolUse(m.message, toolUseSummary);
        }
        yield msg;
      }
    })();
  };

  const systemPrompt = buildDevSystemPrompt(tempdir);
  const agent = createClaudeAgent({
    model: DEV_MODEL,
    allowedTools: [...DEV_ALLOWED_TOOLS],
    disallowedTools: [...DEV_DISALLOWED_TOOLS],
    permissionMode: 'acceptEdits',
    systemPrompt,
    maxTurnsPerIteration: 25,
    maxBudgetUsdPerIteration: 0.50,
    queryFn: tallyingQueryFn,
  });

  const qualityGate = makeQualityGate(worktreePath, input.expected.quality_gate_cmd);

  const loopInput: LoopInput = {
    workItemSpecPath,
    worktreePath,
    initiativeBudget: {
      iterations: input.expected.max_iterations,
      // S4: per C19 there is no $-cap on the bench either.
      usd: input.expected.max_cost_usd ?? Number.POSITIVE_INFINITY,
    },
    brainQueryResults:
      '_(seeded by skill step 1; v1 leaves this empty — the agent has the brain index in its system prompt and can Read themes itself during iteration 1.)_',
    cycleId: `bench-${input.fixtureId}`,
    initiativeId: input.initiativeId,
    qualityGate,
  };

  const startedAt = Date.now();
  let result: LoopResult | null = null;
  let runnerError: RunDevResult['runnerError'];

  try {
    result = await run(loopInput, agent);
  } catch (err) {
    runnerError = {
      kind: 'agent_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const durationMs = Date.now() - startedAt;
  const costUsd = result?.cost_usd ?? 0;

  // Normalise filesChanged paths to worktree-relative (the SDK adapter may
  // report absolute paths). Filter out any reported outside the worktree —
  // the agent shouldn't be touching them, but if it does the score will
  // already penalise scope; we don't double-penalise via path noise.
  if (result) {
    const normalised: string[] = [];
    for (const f of result.filesChanged) {
      const rel = worktreeRelative(f, worktreePath);
      if (rel !== null) normalised.push(rel);
    }
    result = { ...result, filesChanged: [...new Set(normalised)].sort() };
  }

  // Run the regression command if supplied. Defaults to true (no regression
  // check requested = no regression credit revoked).
  let regressionPassed = true;
  if (input.expected.pre_existing_tests_cmd) {
    regressionPassed = runCommand(worktreePath, input.expected.pre_existing_tests_cmd);
  }

  return {
    result,
    workItem,
    tempdir,
    worktreePath,
    workItemSpecPath,
    durationMs,
    costUsd,
    toolUseSummary,
    regressionPassed,
    runnerError,
  };
}

/** Helper for tests + the score harness: list files modified inside the worktree (best-effort). */
export function listFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/** Test helper: write a string to a path inside a worktree, creating dirs. */
export function writeTo(worktreePath: string, relPath: string, content: string): string {
  const out = resolve(worktreePath, relPath);
  const parent = out.split('/').slice(0, -1).join('/');
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(out, content);
  return out;
}
