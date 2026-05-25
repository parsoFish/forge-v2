/**
 * Ralph loop driver.
 *
 * Implements the LoopInput / LoopResult interface declared in loops/README.md.
 * One run = one work item driven to a stop condition.
 *
 * Wired end-to-end. The Claude Agent SDK adapter lives in claude-agent.ts; the
 * runner accepts any AgentInvocation (default = stubAgent for tests; pass
 * createClaudeAgent() for production). Per-fixture quality-gate commands are
 * injectable via LoopInput.qualityGate; the bench harness uses this to run
 * pytest / bats / node:test as appropriate. Live cycle leaves it undefined and
 * gets the default `npm test --silent`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoCommitWorktreeIfDirty,
  checkStopConditions,
  countOpenFixPlanItems,
  defaultQualityGates,
  type StopCondition,
  type LoopState,
} from './stop-conditions.ts';

export type LoopInput = {
  workItemSpecPath: string;
  worktreePath: string;
  initiativeBudget: { iterations: number; usd: number };
  brainQueryResults: string;
  cycleId: string;
  initiativeId: string;
  /**
   * Per-cycle quality-gate function. Called between iterations; a return of
   * true exits the loop with status 'complete'. May be sync or async — the
   * review-loop's gate calls a verdict-provider that may invoke an SDK call.
   * Defaults to `() => defaultQualityGates(worktreePath)` (shells `npm test
   * --silent`). The bench harness injects per-fixture commands (pytest / bats
   * / etc.).
   */
  qualityGate?: (ctx?: { iteration: number }) => boolean | Promise<boolean>;
  /**
   * F-14: optional per-iteration callback. Called immediately after each
   * agent invocation completes (before the next stop-condition check), with
   * the iteration counter and the agent's per-iteration outputs. The cycle
   * orchestrator uses this to emit `event_type: 'iteration'` events so
   * downstream metrics aggregation has per-iteration cost + file-change
   * data, not just the LoopResult totals.
   *
   * F-23: rich-info fields (`toolsUsed`, `bashCommands`, `lastAssistantText`,
   * `tokensIn`, `tokensOut`) are populated by `createClaudeAgent` so cycle
   * post-mortems can see what the agent actually did per iteration. Stub /
   * test agents may omit them; `onIteration` callers should treat them as
   * optional.
   */
  onIteration?: (
    iteration: number,
    info: AgentIterationInfo,
  ) => void | Promise<void>;
  /**
   * Override the default wedged-detection window (3 iterations of
   * no-progress). Unifier sets this higher (or to a sentinel that
   * disables the check) because its task legitimately includes
   * read-only iterations before the write — e.g. read all WI outputs
   * → judge → compose demo + PR description. The per-WI Ralph keeps
   * the default 3.
   *
   * Set to `Infinity` to disable wedged-detection entirely.
   * 2026-05-24 — surfaced by claude-harness cycle 1 unifier wedging
   * at iter 2 after 2 read-only iters.
   */
  wedgedNoProgressIterations?: number;
  /**
   * Default `true` — see runner main loop. The per-WI Ralph WANTS
   * this on (catches PM-emitted hollow gates per 2026-05-24
   * claude-harness audit: a gate passing before any agent work means
   * it doesn't exercise the AC). Set to `false` for callers whose
   * gate is naturally always-true at iter 0 — currently no such
   * caller, but the unifier might want it if a re-run finds a leftover
   * DEMO.md.
   */
  failOnHollowIter0Gate?: boolean;
};

/**
 * F-23: per-iteration agent observability payload. All rich fields are
 * optional so stub / test agents that only return `filesChanged + costUsd`
 * continue to type-check.
 */
export type AgentIterationInfo = {
  filesChanged: string[];
  costUsd: number;
  toolsUsed?: ToolUseDetail[];
  bashCommands?: string[];
  lastAssistantText?: string;
  tokensIn?: number;
  tokensOut?: number;
  /**
   * S8 / C23 — prompt-cache hit telemetry. Populated by `createClaudeAgent`
   * from the SDK's `result.usage.cache_read_input_tokens`. Stub / test
   * agents may omit; consumers treat as optional and default to 0.
   */
  cacheReadTokens?: number;
  /**
   * S8 / C23 — prompt-cache write telemetry. Populated by
   * `createClaudeAgent` from the SDK's
   * `result.usage.cache_creation_input_tokens`. Optional; defaults to 0.
   */
  cacheCreationTokens?: number;
};

export type ToolUseDetail = {
  name: string;
  /** Truncated JSON of the tool's input — enough to identify the call without bloating logs. */
  inputSummary: string;
};

export type LoopResult = {
  status: 'complete' | 'failed' | 'wedged';
  iterations: number;
  cost_usd: number;
  duration_ms: number;
  artifacts: { agentMdPath: string; fixPlanPath: string };
  filesChanged: string[];
  stop_reason: StopCondition['kind'];
};

export type AgentInvocation = (params: {
  promptPath: string;
  agentMdPath: string;
  fixPlanPath: string;
  worktreePath: string;
  iteration: number;
}) => Promise<AgentIterationInfo>;

/** Stub agent invocation — replace with @anthropic-ai/claude-agent-sdk query() call. */
const stubAgent: AgentInvocation = async () => {
  return { filesChanged: [], costUsd: 0 };
};

export type DevWorkspacePaths = {
  promptPath: string;
  agentMdPath: string;
  fixPlanPath: string;
};

/**
 * Stamp PROMPT.md / AGENT.md / fix_plan.md into the worktree from templates if
 * they don't exist yet, and return their absolute paths. Idempotent — already-
 * stamped files are left alone (a re-entrant cycle inherits prior state).
 *
 * Exported so the bench harness and the live cycle wiring can prepare a
 * workspace without going through `run()` (e.g., for inspection in tests).
 */
export function prepareWorkspace(input: LoopInput): DevWorkspacePaths {
  const promptPath = join(input.worktreePath, 'PROMPT.md');
  const agentMdPath = join(input.worktreePath, 'AGENT.md');
  const fixPlanPath = join(input.worktreePath, 'fix_plan.md');
  ensureScaffolded(input, promptPath, agentMdPath, fixPlanPath);
  return { promptPath, agentMdPath, fixPlanPath };
}

export async function run(input: LoopInput, agent: AgentInvocation = stubAgent): Promise<LoopResult> {
  const startedAt = Date.now();
  const { promptPath, agentMdPath, fixPlanPath } = prepareWorkspace(input);

  // wedgedNoProgressIterations: caller-overridable (unifier sets 6+ so
  // its legitimate read-only iters don't false-fire the wedged check).
  // Infinity → disabled (no wedged check at all).
  const wedgedWindow = input.wedgedNoProgressIterations ?? 3;
  const conditions: StopCondition[] = [
    { kind: 'quality-gates-pass' },
    { kind: 'iteration-budget', max: input.initiativeBudget.iterations },
    { kind: 'cost-budget', maxUsd: input.initiativeBudget.usd },
    ...(Number.isFinite(wedgedWindow)
      ? [{ kind: 'wedged' as const, noProgressIterations: wedgedWindow }]
      : []),
  ];

  const qualityGate = input.qualityGate ?? ((ctx) => defaultQualityGates(input.worktreePath, undefined, ctx));

  const state: LoopState = {
    worktreePath: input.worktreePath,
    iteration: 0,
    costUsdSoFar: 0,
    fixPlanItemsHistory: [countOpenFixPlanItems(input.worktreePath)],
    filesChangedHistory: [],
  };

  // Caller-overridable iter-0 hollow-gate detection. Defaults to TRUE
  // for per-WI Ralphs (per the 2026-05-24 claude-harness audit: a gate
  // that passes BEFORE the agent has done any work is by definition
  // not exercising the WI's acceptance criteria; fail the WI early
  // with a clear classification rather than wasting iters on a hollow
  // gate). The unifier sets this FALSE because its gate (`pr_self_
  // contained`) checks for DEMO.md + pr-description.md, neither of
  // which can exist before the agent writes them — the unifier's
  // iter-0 gate-pass condition would be a no-op false positive.
  const failOnHollowGate = input.failOnHollowIter0Gate ?? true;

  for (;;) {
    // Iter-0: run the full set including quality-gates-pass. If it
    // passes here, the gate is hollow — bail with a synthetic stop
    // condition the caller surfaces as `gate-too-loose`.
    if (state.iteration === 0 && failOnHollowGate) {
      const passed = await Promise.resolve(qualityGate({ iteration: 0 }));
      if (passed) {
        // stop_reason is the discriminator string — callers
        // (developer-loop, cycle.ts, failure-classifier) read this to
        // surface the human-friendly explanation.
        return finalize(state, startedAt, 'gate-too-loose', agentMdPath, fixPlanPath);
      }
    }

    const conditionsForThisCheck =
      state.iteration === 0
        ? conditions.filter((c) => c.kind !== 'quality-gates-pass')
        : conditions;
    const stop = await checkStopConditions(state, conditionsForThisCheck, qualityGate);
    if (stop.stop) {
      return finalize(state, startedAt, stop.condition, agentMdPath, fixPlanPath);
    }

    state.iteration += 1;
    const result = await agent({
      promptPath,
      agentMdPath,
      fixPlanPath,
      worktreePath: input.worktreePath,
      iteration: state.iteration,
    });
    state.costUsdSoFar += result.costUsd;
    state.filesChangedHistory.push(result.filesChanged);
    state.fixPlanItemsHistory.push(countOpenFixPlanItems(input.worktreePath));
    // Safety net (surfaced by claude-harness cycle 1, 2026-05-24): if
    // the agent left WIP uncommitted, commit it under a clearly-tagged
    // `forge-autocommit:` message before the next gate check so the
    // required-paths-against-main diff sees the work. The agent's
    // intent IS still "commit your own work" (per dev-invocation
    // system prompt) — this just guarantees the gate doesn't dead-end
    // on iteration-budget when the work is otherwise complete.
    autoCommitWorktreeIfDirty(input.worktreePath, state.iteration, deriveWorkItemId(input.workItemSpecPath));
    if (input.onIteration) {
      // F-23: forward all rich-info fields the agent populated. Plain assignment
      // (no field-by-field copy) keeps onIteration backward compatible with the
      // narrow `{ filesChanged, costUsd }` shape used by stub/test agents.
      await input.onIteration(state.iteration, result);
    }
  }
}

/** Pulls `WI-N` out of a workItemSpecPath like `.forge/work-items/WI-3.md`. */
function deriveWorkItemId(specPath: string): string | undefined {
  const m = specPath.match(/(WI-\d+)\.md$/);
  return m ? m[1] : undefined;
}

function ensureScaffolded(
  input: LoopInput,
  promptPath: string,
  agentMdPath: string,
  fixPlanPath: string,
): void {
  if (!existsSync(promptPath)) {
    const tmpl = readFileSync(join(import.meta.dirname, 'PROMPT.md.tmpl'), 'utf8');
    writeFileSync(
      promptPath,
      tmpl
        .replace(/{{WORK_ITEM_ID}}/g, basename(input.workItemSpecPath, '.md'))
        .replace(/{{INITIATIVE_ID}}/g, input.initiativeId)
        .replace(/{{ITERATION}}/g, '0')
        .replace(/{{ITERATION_BUDGET}}/g, String(input.initiativeBudget.iterations))
        .replace(/{{WORK_ITEM_SPEC_BODY}}/g, readFileSync(input.workItemSpecPath, 'utf8')),
    );
  }
  if (!existsSync(agentMdPath)) {
    const tmpl = readFileSync(join(import.meta.dirname, 'AGENT.md.tmpl'), 'utf8');
    writeFileSync(
      agentMdPath,
      tmpl
        .replace(/{{WORK_ITEM_ID}}/g, basename(input.workItemSpecPath, '.md'))
        .replace(/{{BRAIN_QUERY_RESULTS}}/g, input.brainQueryResults),
    );
  }
  if (!existsSync(fixPlanPath)) {
    writeFileSync(fixPlanPath, '# Fix Plan\n\n_(populate from acceptance criteria)_\n');
  }
}

function finalize(
  state: LoopState,
  startedAt: number,
  stopReason: StopCondition['kind'],
  agentMdPath: string,
  fixPlanPath: string,
): LoopResult {
  const status: LoopResult['status'] =
    stopReason === 'quality-gates-pass'
      ? 'complete'
      : stopReason === 'wedged'
        ? 'wedged'
        : 'failed';
  // gate-too-loose surfaces as a failed WI; the caller (developer-loop)
  // reads stop_reason and classifies the failure mode for the cycle
  // report + the failure-classifier.
  const filesChanged = uniqueFiles(state.filesChangedHistory);
  return {
    status,
    iterations: state.iteration,
    cost_usd: state.costUsdSoFar,
    duration_ms: Date.now() - startedAt,
    artifacts: { agentMdPath, fixPlanPath },
    filesChanged,
    stop_reason: stopReason,
  };
}

function uniqueFiles(history: string[][]): string[] {
  const seen = new Set<string>();
  for (const iter of history) {
    for (const f of iter) seen.add(f);
  }
  return [...seen].sort();
}

function basename(p: string, ext: string): string {
  const last = p.split('/').pop() ?? p;
  return last.endsWith(ext) ? last.slice(0, -ext.length) : last;
}
