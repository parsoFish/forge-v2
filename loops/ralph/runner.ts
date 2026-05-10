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
  qualityGate?: () => boolean | Promise<boolean>;
  /**
   * F-14: optional per-iteration callback. Called immediately after each
   * agent invocation completes (before the next stop-condition check), with
   * the iteration counter and the agent's per-iteration outputs. The cycle
   * orchestrator uses this to emit `event_type: 'iteration'` events so
   * downstream metrics aggregation has per-iteration cost + file-change
   * data, not just the LoopResult totals.
   */
  onIteration?: (
    iteration: number,
    info: { filesChanged: string[]; costUsd: number },
  ) => void | Promise<void>;
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
}) => Promise<{ filesChanged: string[]; costUsd: number }>;

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

  const conditions: StopCondition[] = [
    { kind: 'quality-gates-pass' },
    { kind: 'iteration-budget', max: input.initiativeBudget.iterations },
    { kind: 'cost-budget', maxUsd: input.initiativeBudget.usd },
    { kind: 'wedged', noProgressIterations: 3 },
  ];

  const qualityGate = input.qualityGate ?? (() => defaultQualityGates(input.worktreePath));

  const state: LoopState = {
    worktreePath: input.worktreePath,
    iteration: 0,
    costUsdSoFar: 0,
    fixPlanItemsHistory: [countOpenFixPlanItems(input.worktreePath)],
    filesChangedHistory: [],
  };

  for (;;) {
    const stop = await checkStopConditions(state, conditions, qualityGate);
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
    if (input.onIteration) {
      await input.onIteration(state.iteration, {
        filesChanged: result.filesChanged,
        costUsd: result.costUsd,
      });
    }
  }
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
