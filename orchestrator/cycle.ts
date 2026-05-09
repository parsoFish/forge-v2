/**
 * Run one initiative end-to-end:
 *   PM → developer-loop (per work item) → review-prep
 *
 * The orchestrator's only job is to thread phase outputs into the next phase's
 * inputs. Each phase is invoked by calling its skill via the Claude Agent SDK
 * (or, for the developer loop, via loops/ralph/runner.ts).
 *
 * STATUS: skeleton. Each phase invocation is a no-op stub that emits start/end
 * events to the log so the wiring is provable. Implementation lands per
 * docs/phases/<phase>.md.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { EventLogger } from './logging.ts';
import { createLogger } from './logging.ts';
import { parseManifest } from './manifest.ts';
import {
  PM_ALLOWED_TOOLS,
  PM_DISALLOWED_TOOLS,
  PM_MODEL,
  buildPmSystemPrompt,
  renderPmUserPrompt,
  tallyToolUse,
  type PmToolUseSummary,
} from './pm-invocation.ts';
import {
  DEV_ALLOWED_TOOLS,
  DEV_DISALLOWED_TOOLS,
  DEV_MODEL,
  buildDevSystemPrompt,
  prepareDevWorkspace,
  tallyToolUse as tallyDevToolUse,
  type DevToolUseSummary,
} from './dev-invocation.ts';
import {
  REVIEWER_ALLOWED_TOOLS,
  REVIEWER_DISALLOWED_TOOLS,
  REVIEWER_MODEL,
  buildReviewerSystemPrompt,
  prepareReviewerWorkspace,
  tallyToolUse as tallyReviewerToolUse,
  type ReviewerToolUseSummary,
} from './reviewer-invocation.ts';
import {
  makeReviewerQualityGate,
  type GetVerdict,
  type ReviewerGateState,
} from './reviewer-stage2.ts';
import { moveTo as moveQueueItem } from './queue.ts';
import { notify } from './notify.ts';
import {
  readWorkItemsFromDir,
  topologicalOrder,
  validateWorkItemSet,
  writeWorkItemStatus,
  type WorkItem,
} from './work-item.ts';
import { createClaudeAgent, type QueryFn } from '../loops/ralph/claude-agent.ts';
import { run as runRalph, type LoopResult } from '../loops/ralph/runner.ts';

export type CycleInput = {
  initiativeId: string;
  manifestPath: string;
  projectRepoPath: string;
  worktreePath: string;
  cycleId?: string;
  dryRun?: boolean;
  /**
   * Verdict provider for the review-Ralph loop. Production: stdin-prompt
   * adapter (deferred). Bench: simulator agent. When absent, the review-loop
   * uses a default that approves on the first call — appropriate for the
   * per-phase review-loop bench (which only tests stage 1) but NOT for
   * end-to-end runs (the e2e bench supplies a real simulator).
   */
  getVerdict?: GetVerdict;
  /** Project quality-gate command run by the orchestrator between review iterations. Defaults to `npm test` if package.json is present, otherwise `true`. */
  qualityGateCmd?: string[];
  /**
   * Cap on review-Ralph iterations. 1 prep + N send-back rounds. Default 3
   * (1 prep + 2 send-backs) per the phase-doc target.
   */
  reviewIterationCap?: number;
  /**
   * Per-iteration USD cap for the review-Ralph. Default 1.0. The full
   * Ralph budget = reviewIterationCap × this.
   */
  reviewIterationBudgetUsd?: number;
};

export type CycleResult = {
  cycle_id: string;
  initiative_id: string;
  status: 'merged' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
  duration_ms: number;
  log_path: string;
};

export async function runCycle(input: CycleInput): Promise<CycleResult> {
  const started = Date.now();
  const cycleId = input.cycleId ?? newCycleId(input.initiativeId);
  const logger = createLogger(cycleId);

  logger.emit({
    initiative_id: input.initiativeId,
    phase: 'orchestrator',
    skill: 'cycle',
    event_type: 'start',
    input_refs: [input.manifestPath],
    output_refs: [],
    message: input.dryRun ? 'cycle.start (dry run)' : 'cycle.start',
  });

  let reviewerOutcome: ReviewerOutcome = 'ready-for-review';
  try {
    if (!input.dryRun) {
      await runProjectManager(input, logger);
      await runDeveloperLoop(input, logger);
      // Safety net: commit any uncommitted dev-loop work before the reviewer
      // starts. The dev-loop's prompt tells the agent to commit per
      // iteration, but if it skips, the reviewer's gh-shim does
      // `git reset --hard HEAD` and the source files vanish. This
      // boundary commit catches any drift. Files matching .gitignore
      // (Ralph scratch: PROMPT.md / AGENT.md / fix_plan.md, node_modules)
      // are excluded by `git add` automatically.
      commitDevLoopBoundary(input.worktreePath, logger, input.initiativeId);
      reviewerOutcome = await runReviewer(input, logger);
    }

    const result: CycleResult = {
      cycle_id: cycleId,
      initiative_id: input.initiativeId,
      status: reviewerOutcome,
      duration_ms: Date.now() - started,
      log_path: logger.logFilePath,
    };

    logger.emit({
      initiative_id: input.initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'end',
      input_refs: [input.manifestPath],
      output_refs: [logger.logFilePath],
      duration_ms: result.duration_ms,
      message: 'cycle.end',
      metadata: { status: result.status },
    });

    return result;
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'error',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      cycle_id: cycleId,
      initiative_id: input.initiativeId,
      status: 'failed',
      duration_ms: Date.now() - started,
      log_path: logger.logFilePath,
    };
  }
}

/**
 * Defaults for the live PM invocation. Higher budget + turn cap than the bench
 * (real worktrees are richer than fixtures); the bench enforces 0.5 USD / 30
 * turns to keep iteration cheap.
 */
const PM_LIVE_MAX_TURNS = 50;
const PM_LIVE_MAX_BUDGET_USD = 1.0;

async function runProjectManager(input: CycleInput, logger: EventLogger): Promise<void> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: 'start',
    input_refs: [input.manifestPath],
    output_refs: [],
  });

  const manifest = parseManifest(readFileSync(input.manifestPath, 'utf8'));
  const featureCountByFeatureId = new Map<string, number>();
  for (const f of manifest.features) featureCountByFeatureId.set(f.feature_id, 0);

  const forgeRoot = resolve(import.meta.dirname, '..');
  const systemPrompt = buildPmSystemPrompt(forgeRoot);
  const prompt = renderPmUserPrompt({
    initiativeId: input.initiativeId,
    manifestRelPath: input.manifestPath,
    worktreeRelPath: input.worktreePath,
    projectName: manifest.project,
    minWorkItems: Math.max(manifest.features.length, 2),
    maxWorkItems: Math.max(manifest.features.length * 4, 6),
    parallelFractionAtLeast: 0.3,
  });

  const options: Record<string, unknown> = {
    cwd: forgeRoot,
    systemPrompt,
    model: PM_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: PM_ALLOWED_TOOLS,
    disallowedTools: PM_DISALLOWED_TOOLS,
    maxTurns: PM_LIVE_MAX_TURNS,
    maxBudgetUsd: PM_LIVE_MAX_BUDGET_USD,
  };

  const toolUseSummary: PmToolUseSummary = { brainReads: 0, writes: 0, bashCalls: 0 };
  let costUsd = 0;
  let durationMs = 0;
  let resultSubtype: string | undefined;

  for await (const msg of sdkQuery({ prompt, options }) as AsyncIterable<unknown>) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> }; subtype?: string; total_cost_usd?: number; duration_ms?: number };
    if (m.type === 'assistant') {
      tallyToolUse(m.message, toolUseSummary);
      continue;
    }
    if (m.type !== 'result') continue;
    if (typeof m.duration_ms === 'number') durationMs = m.duration_ms;
    if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
    resultSubtype = m.subtype ?? 'success';
    break;
  }

  for (let i = 0; i < toolUseSummary.brainReads; i++) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'tool_use',
      input_refs: ['brain/'],
      output_refs: [],
      message: 'pm.brain-query',
    });
  }

  const workItemsDir = resolve(input.worktreePath, '.forge', 'work-items');
  const { items, parseErrors } = readWorkItemsFromDir(workItemsDir);

  for (const item of items) {
    const prev = featureCountByFeatureId.get(item.feature_id) ?? 0;
    featureCountByFeatureId.set(item.feature_id, prev + 1);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [resolve(workItemsDir, `${item.work_item_id}.md`)],
      message: 'pm.work-item-emitted',
      metadata: { work_item_id: item.work_item_id, feature_id: item.feature_id },
    });
  }

  for (const [featureId, count] of featureCountByFeatureId.entries()) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'project-manager',
      skill: 'project-manager',
      event_type: 'log',
      input_refs: [input.manifestPath],
      output_refs: [],
      message: 'pm.feature-decomposed',
      metadata: { feature_id: featureId, work_item_count: count },
    });
  }

  const knownFeatureIds = new Set(manifest.features.map((f) => f.feature_id));
  const { perItem, setErrors } = validateWorkItemSet(items, {
    expectedInitiativeId: manifest.initiative_id,
    knownFeatureIds,
  });
  const itemErrorCount = Object.values(perItem).reduce((acc, errs) => acc + errs.length, 0);
  const failed =
    items.length === 0 ||
    Object.keys(parseErrors).length > 0 ||
    setErrors.length > 0 ||
    itemErrorCount > 0;

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: 'log',
    input_refs: [input.manifestPath],
    output_refs: [resolve(workItemsDir, '_graph.md')],
    message: 'pm.graph-emitted',
  });

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'project-manager',
    skill: 'project-manager',
    event_type: failed ? 'error' : 'end',
    input_refs: [input.manifestPath],
    output_refs: [workItemsDir],
    duration_ms: durationMs,
    cost_usd: costUsd,
    metadata: {
      work_item_count: items.length,
      result_subtype: resultSubtype,
      tool_use: toolUseSummary,
      parse_errors: parseErrors,
      set_errors: setErrors,
      per_item_error_count: itemErrorCount,
    },
  });

  if (failed) {
    const summary = [
      items.length === 0 ? 'no work items emitted' : null,
      Object.keys(parseErrors).length > 0 ? `parse errors: ${Object.keys(parseErrors).join(', ')}` : null,
      setErrors.length > 0 ? `set errors: ${setErrors.join('; ')}` : null,
      itemErrorCount > 0 ? `${itemErrorCount} per-item validation errors` : null,
    ]
      .filter((s): s is string => s !== null)
      .join('; ');
    throw new Error(`project-manager phase failed: ${summary}`);
  }
}

/**
 * Defaults for the live Ralph loop. Higher per-iteration USD cap than the bench
 * (live worktrees are richer); the bench tightens to 0.30 USD / 3 iterations
 * per fixture to surface efficiency regressions quickly.
 */
const DEV_LIVE_DEFAULT_ITERATIONS_PER_WI = 5;
const DEV_LIVE_DEFAULT_USD_PER_WI = 1.0;
const DEV_LIVE_MAX_TURNS_PER_ITERATION = 25;
const DEV_LIVE_MAX_BUDGET_USD_PER_ITERATION = 0.50;

async function runDeveloperLoop(input: CycleInput, logger: EventLogger): Promise<void> {
  const workItemsDir = resolve(input.worktreePath, '.forge/work-items');
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'developer-loop',
    skill: 'developer-ralph',
    event_type: 'start',
    input_refs: [workItemsDir],
    output_refs: [],
  });

  const { items, parseErrors } = readWorkItemsFromDir(workItemsDir);
  if (Object.keys(parseErrors).length > 0) {
    throw new Error(
      `developer-loop: parse errors: ${Object.entries(parseErrors).map(([f, e]) => `${f}: ${e}`).join('; ')}`,
    );
  }
  if (items.length === 0) {
    throw new Error(`developer-loop: no work items found at ${workItemsDir}`);
  }
  const { setErrors } = validateWorkItemSet(items);
  if (setErrors.length > 0) {
    throw new Error(`developer-loop: invalid WI set: ${setErrors.join('; ')}`);
  }

  const ordered = topologicalOrder(items);
  const forgeRoot = resolve(import.meta.dirname, '..');
  const systemPrompt = buildDevSystemPrompt(forgeRoot);
  const sdkQueryFn = sdkQuery as unknown as QueryFn;

  const wiOutcomes: Array<{ id: string; status: WorkItem['status']; result: LoopResult | null }> = [];

  for (const wi of ordered) {
    const wiStart = logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'log',
      input_refs: [resolve(workItemsDir, `${wi.work_item_id}.md`)],
      output_refs: [],
      message: 'ralph.start',
      metadata: { work_item_id: wi.work_item_id, feature_id: wi.feature_id },
    });

    if (prerequisiteFailed(wi, wiOutcomes)) {
      writeWorkItemStatus(resolve(workItemsDir, `${wi.work_item_id}.md`), 'failed');
      logger.emit({
        initiative_id: input.initiativeId,
        parent_event_id: wiStart.event_id,
        phase: 'developer-loop',
        skill: 'developer-ralph',
        event_type: 'log',
        input_refs: [resolve(workItemsDir, `${wi.work_item_id}.md`)],
        output_refs: [],
        message: 'ralph.skipped',
        metadata: { work_item_id: wi.work_item_id, reason: 'prerequisite-failed' },
      });
      wiOutcomes.push({ id: wi.work_item_id, status: 'failed', result: null });
      continue;
    }

    const specPath = resolve(workItemsDir, `${wi.work_item_id}.md`);
    const wiToolUse: DevToolUseSummary = { reads: 0, writes: 0, bashCalls: 0, testRuns: 0 };

    prepareDevWorkspace({
      initiativeId: input.initiativeId,
      workItemSpecPath: specPath,
      workItemSpecRelPath: `.forge/work-items/${wi.work_item_id}.md`,
      worktreePath: input.worktreePath,
      iterationBudget: wi.estimated_iterations > 0
        ? Math.max(wi.estimated_iterations, DEV_LIVE_DEFAULT_ITERATIONS_PER_WI)
        : DEV_LIVE_DEFAULT_ITERATIONS_PER_WI,
      costBudgetUsd: DEV_LIVE_DEFAULT_USD_PER_WI,
    });

    const tallyingQueryFn: QueryFn = ({ prompt, options }) => {
      const inner = sdkQueryFn({ prompt, options });
      return (async function* () {
        for await (const msg of inner) {
          const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } };
          if (m.type === 'assistant') tallyDevToolUse(m.message, wiToolUse);
          yield msg;
        }
      })();
    };

    const agent = createClaudeAgent({
      model: DEV_MODEL,
      allowedTools: [...DEV_ALLOWED_TOOLS],
      disallowedTools: [...DEV_DISALLOWED_TOOLS],
      permissionMode: 'acceptEdits',
      systemPrompt,
      maxTurnsPerIteration: DEV_LIVE_MAX_TURNS_PER_ITERATION,
      maxBudgetUsdPerIteration: DEV_LIVE_MAX_BUDGET_USD_PER_ITERATION,
      queryFn: tallyingQueryFn,
    });

    let result: LoopResult | null = null;
    let runnerError: { kind: string; message: string } | undefined;
    try {
      result = await runRalph(
        {
          workItemSpecPath: specPath,
          worktreePath: input.worktreePath,
          initiativeBudget: {
            iterations: Math.max(wi.estimated_iterations, DEV_LIVE_DEFAULT_ITERATIONS_PER_WI),
            usd: DEV_LIVE_DEFAULT_USD_PER_WI,
          },
          brainQueryResults: '',
          cycleId: logger.cycleId,
          initiativeId: input.initiativeId,
        },
        agent,
      );
    } catch (err) {
      runnerError = {
        kind: 'agent_threw',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const finalStatus: WorkItem['status'] = result?.status === 'complete'
      ? 'complete'
      : 'failed';
    writeWorkItemStatus(specPath, finalStatus);

    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: wiStart.event_id,
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'end',
      input_refs: [specPath],
      output_refs: result ? result.filesChanged : [],
      cost_usd: result?.cost_usd ?? 0,
      duration_ms: result?.duration_ms ?? 0,
      message: 'ralph.end',
      metadata: {
        work_item_id: wi.work_item_id,
        status: finalStatus,
        iterations: result?.iterations ?? 0,
        stop_reason: result?.stop_reason ?? 'crashed',
        tool_use: wiToolUse,
        runner_error: runnerError,
      },
    });

    wiOutcomes.push({ id: wi.work_item_id, status: finalStatus, result });
  }

  const completeCount = wiOutcomes.filter((o) => o.status === 'complete').length;
  const totalCost = wiOutcomes.reduce((acc, o) => acc + (o.result?.cost_usd ?? 0), 0);

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'developer-loop',
    skill: 'developer-ralph',
    event_type: 'end',
    input_refs: [workItemsDir],
    output_refs: [input.worktreePath],
    cost_usd: totalCost,
    metadata: {
      work_item_count: items.length,
      complete: completeCount,
      failed: items.length - completeCount,
    },
  });

  // Partial dev-loop completion is NOT fatal to the cycle. The reviewer's
  // send-back loop is the gap-filler — once gates flip green from any WI
  // and src/ is non-empty, the reviewer can run, the simulator/human can
  // identify what's missing, and feedback rounds can complete the work.
  // Only throw when ZERO WIs succeeded (total dev-loop failure); otherwise
  // emit the partial outcome and hand off to the reviewer.
  if (completeCount === 0 && items.length > 0) {
    throw new Error(
      `developer-loop: 0/${items.length} work items completed — total failure`,
    );
  }
}

function prerequisiteFailed(
  wi: WorkItem,
  outcomes: Array<{ id: string; status: WorkItem['status'] }>,
): boolean {
  if (wi.depends_on.length === 0) return false;
  const byId = new Map(outcomes.map((o) => [o.id, o.status] as const));
  for (const dep of wi.depends_on) {
    const status = byId.get(dep);
    if (status === 'failed') return true;
  }
  return false;
}

/**
 * Defaults for the live reviewer Ralph loop. The agent runs as a Ralph loop
 * on the initiative branch; the orchestrator's quality-gate function calls
 * `getVerdict` between iterations. On `approve`, the orchestrator merges +
 * moves the manifest to `_queue/done/` + fires the notification. On
 * `send-back`, the gate appends feedback to fix_plan.md and the loop
 * continues. Cap: 3 iterations (1 prep + 2 send-back rounds).
 */
const REVIEWER_LIVE_DEFAULT_ITERATIONS = 3;
const REVIEWER_LIVE_DEFAULT_USD_PER_ITERATION = 1.0;
const REVIEWER_LIVE_MAX_TURNS_PER_ITERATION = 40;
const REVIEWER_LIVE_MAX_BUDGET_USD_PER_ITERATION = 0.6;

export type ReviewerOutcome = 'merged' | 'ready-for-review' | 'send-back-cap-exhausted';

/**
 * Infer project type from the worktree contents. Used to give the reviewer
 * agent the right demo-tool default in its iteration prompt.
 */
function inferProjectType(worktreePath: string): 'browser' | 'cli' | 'lib' | 'rest' {
  if (
    existsSync(resolve(worktreePath, 'playwright.config.ts')) ||
    existsSync(resolve(worktreePath, 'playwright.config.js'))
  ) {
    return 'browser';
  }
  if (existsSync(resolve(worktreePath, 'index.html'))) return 'browser';
  if (
    existsSync(resolve(worktreePath, 'openapi.yaml')) ||
    existsSync(resolve(worktreePath, 'openapi.json'))
  ) {
    return 'rest';
  }
  if (existsSync(resolve(worktreePath, 'bin')) || existsSync(resolve(worktreePath, 'cmd'))) {
    return 'cli';
  }
  return 'lib';
}

/**
 * Best-effort PR creation via `gh pr create`. Returns the PR URL on success,
 * or null on failure. The reviewer's PR-description draft lives at
 * `<worktree>/.forge/pr-description.md` and is passed via `--body-file`.
 */
function openPullRequest(worktreePath: string, prDescriptionPath: string): string | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'create', '--body-file', prDescriptionPath, '--title', basename(worktreePath)],
      { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' },
    );
    const match = out.match(/https:\S+/);
    return match ? match[0] : out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort `gh pr merge` for the approved PR. Returns true on success.
 * The PR-create + PR-merge split lets bench-mode use a `gh` shim that
 * records the operations locally without touching real GitHub.
 */
function mergePullRequest(worktreePath: string): boolean {
  try {
    execFileSync('gh', ['pr', 'merge', '--merge', '--delete-branch'], {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    // Surface the stderr for diagnostic visibility — the orchestrator's
    // event-log captures this via the merge-failed event_type.
    const e = err as { stderr?: Buffer | string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (stderr) process.stderr.write(`[mergePullRequest] ${stderr}\n`);
    return false;
  }
}

/**
 * Default verdict-provider used when CycleInput.getVerdict is omitted. The
 * per-phase review-loop bench (which only tests stage 1) omits getVerdict —
 * we approve immediately so the loop terminates after iteration 1, matching
 * the prior closure's behaviour. Production / e2e bench supplies a real
 * verdict-provider.
 */
const defaultGetVerdict: GetVerdict = async () => ({
  kind: 'approve',
  rationale:
    'default verdict-provider — supply CycleInput.getVerdict to drive stage 2 properly.',
});

async function runReviewer(input: CycleInput, logger: EventLogger): Promise<ReviewerOutcome> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: 'start',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
  });

  const forgeRoot = resolve(import.meta.dirname, '..');
  const projectType = inferProjectType(input.worktreePath);
  const qualityGateCmd =
    input.qualityGateCmd ??
    (existsSync(resolve(input.worktreePath, 'package.json')) ? ['npm', 'test'] : ['true']);
  const iterationCap = input.reviewIterationCap ?? REVIEWER_LIVE_DEFAULT_ITERATIONS;
  const usdBudget =
    input.reviewIterationBudgetUsd ?? REVIEWER_LIVE_DEFAULT_USD_PER_ITERATION;

  // Read the completed work items the reviewer will be reviewing.
  const workItemsDir = resolve(input.worktreePath, '.forge', 'work-items');
  const { items: workItems } = readWorkItemsFromDir(workItemsDir);

  // Wipe the dev-loop's leftover PROMPT.md / AGENT.md / fix_plan.md before
  // stamping the reviewer's. The dev-loop's stamps are per-WI scratch state
  // for THAT phase; the review-Ralph is a different mission with a different
  // iteration prompt. Without this, prepareReviewerWorkspace's idempotency
  // would leave the agent reading stale dev-loop content and hallucinating
  // its role.
  for (const f of ['PROMPT.md', 'AGENT.md', 'fix_plan.md']) {
    const p = resolve(input.worktreePath, f);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }

  // Stamp PROMPT.md / AGENT.md / fix_plan.md into the worktree.
  const { promptPath, agentMdPath, fixPlanPath } = prepareReviewerWorkspace({
    initiativeId: input.initiativeId,
    manifestRelPath: input.manifestPath,
    worktreeRelPath: input.worktreePath,
    worktreePath: input.worktreePath,
    projectName: basename(input.worktreePath),
    projectType,
    qualityGateCmd: qualityGateCmd.join(' '),
    isStackedPr: false,
    workItems,
  });

  // Build the SDK agent invocation closure that Ralph calls each iteration.
  const toolUseSummary: ReviewerToolUseSummary = {
    brainReads: 0,
    writes: 0,
    bashCalls: 0,
    recorderInvocations: 0,
  };

  const systemPrompt = buildReviewerSystemPrompt(forgeRoot);
  const tallyingQueryFn: QueryFn = ({ prompt, options }) => {
    const inner = sdkQuery({ prompt, options }) as AsyncIterable<unknown>;
    return (async function* () {
      for await (const msg of inner) {
        const m = msg as {
          type?: string;
          message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
        };
        if (m.type === 'assistant') {
          tallyReviewerToolUse(m.message, toolUseSummary);
        }
        yield msg;
      }
    })();
  };
  const agent = createClaudeAgent({
    model: REVIEWER_MODEL,
    allowedTools: [...REVIEWER_ALLOWED_TOOLS],
    disallowedTools: [...REVIEWER_DISALLOWED_TOOLS],
    permissionMode: 'acceptEdits',
    systemPrompt,
    maxTurnsPerIteration: REVIEWER_LIVE_MAX_TURNS_PER_ITERATION,
    maxBudgetUsdPerIteration: REVIEWER_LIVE_MAX_BUDGET_USD_PER_ITERATION,
    queryFn: tallyingQueryFn,
  });

  // Build the orchestrator-side verdict gate.
  const gateState: ReviewerGateState = {
    invocations: 0,
    verdicts: [],
    qualityGateResults: [],
  };
  const qualityGate = makeReviewerQualityGate(
    {
      initiativeId: input.initiativeId,
      worktreePath: input.worktreePath,
      manifestPath: input.manifestPath,
      workItems,
      fixPlanPath,
      agentMdPath,
      qualityGateCmd,
    },
    input.getVerdict ?? defaultGetVerdict,
    gateState,
  );

  // Drive the review-Ralph loop. workItemSpecPath is unused by reviewer-Ralph
  // (we don't have a single WI; the manifest references the whole set), so we
  // hand promptPath as a stand-in — Ralph's runner only reads it for
  // template-stamping fallbacks, and prepareReviewerWorkspace already stamped
  // PROMPT.md so the runner's fallback path won't be taken.
  let loopResult: LoopResult;
  try {
    loopResult = await runRalph(
      {
        workItemSpecPath: promptPath, // unused; PROMPT.md already exists
        worktreePath: input.worktreePath,
        initiativeBudget: { iterations: iterationCap, usd: usdBudget * iterationCap },
        brainQueryResults:
          '_(seeded by skill step 1; v1 leaves this empty — the agent has the brain index in its system prompt and can Read themes itself during iteration 1.)_',
        cycleId: 'live',
        initiativeId: input.initiativeId,
        qualityGate,
      },
      agent,
    );
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'reviewer.crashed',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  // Emit per-verdict events post-loop.
  for (const verdict of gateState.verdicts) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: verdict.kind === 'approve' ? 'reviewer.verdict.approve' : 'reviewer.verdict.send-back',
      metadata: {
        rationale: verdict.rationale,
        feedback_count: verdict.kind === 'send-back' ? verdict.feedback.length : 0,
      },
    });
  }

  const lastVerdict = gateState.verdicts.at(-1);
  const approved = lastVerdict?.kind === 'approve' && loopResult.status === 'complete';

  let outcome: ReviewerOutcome;
  let prUrl: string | null = null;

  if (approved) {
    // Open the PR (best-effort) and immediately merge.
    const prDescriptionPath = resolve(input.worktreePath, '.forge', 'pr-description.md');
    prUrl = openPullRequest(input.worktreePath, prDescriptionPath);
    const merged = mergePullRequest(input.worktreePath);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: merged ? 'log' : 'error',
      input_refs: [prDescriptionPath],
      output_refs: prUrl ? [prUrl] : [],
      message: merged ? 'reviewer.merged' : 'reviewer.merge-failed',
      metadata: { url: prUrl, merged, pr_created: prUrl !== null },
    });

    if (!merged) {
      // gh merge failed — leave the manifest in in-flight, treat as ready-for-review.
      // Operator can pick up via the production CLI (or a follow-up cycle).
      try {
        moveQueueItem(basename(input.manifestPath), 'ready-for-review');
      } catch {
        /* best-effort */
      }
      logger.emit({
        initiative_id: input.initiativeId,
        parent_event_id: start.event_id,
        phase: 'review-loop',
        skill: 'reviewer',
        event_type: 'end',
        input_refs: [input.worktreePath],
        output_refs: prUrl ? [prUrl] : [],
        duration_ms: loopResult.duration_ms,
        cost_usd: loopResult.cost_usd,
        metadata: {
          outcome: 'ready-for-review',
          iterations: loopResult.iterations,
          stop_reason: loopResult.stop_reason,
          gate_invocations: gateState.invocations,
          verdicts_summary: gateState.verdicts.map((v) => v.kind),
          tool_use: toolUseSummary,
          pr_url: prUrl,
          merge_failed: true,
        },
      });
      return 'ready-for-review';
    }

    // Move manifest to _queue/done/ and fire notification.
    try {
      moveQueueItem(basename(input.manifestPath), 'done');
    } catch (err) {
      logger.emit({
        initiative_id: input.initiativeId,
        parent_event_id: start.event_id,
        phase: 'review-loop',
        skill: 'reviewer',
        event_type: 'error',
        input_refs: [input.manifestPath],
        output_refs: [],
        message: 'reviewer.queue-move-failed',
        metadata: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    try {
      await notify(
        {
          type: 'review-ready',
          title: input.initiativeId,
          body: prUrl ? `Merged: ${prUrl}` : 'Initiative merged to main',
          url: prUrl ?? undefined,
          metadata: { initiative_id: input.initiativeId, outcome: 'merged' },
        },
        { desktop: true, webhook_url: null },
      );
    } catch {
      /* best-effort */
    }
    outcome = 'merged';
  } else if (loopResult.stop_reason === 'iteration-budget') {
    outcome = 'send-back-cap-exhausted';
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'reviewer.send-back-cap-exhausted',
      metadata: { rounds: gateState.invocations },
    });
  } else {
    // Loop ended without approval AND not via iteration budget — wedged or
    // another stop condition. Treat as ready-for-review (PR draft exists but
    // not approved); operator can pick up manually.
    outcome = 'ready-for-review';
    try {
      moveQueueItem(basename(input.manifestPath), 'ready-for-review');
    } catch {
      /* best-effort */
    }
  }

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: outcome === 'send-back-cap-exhausted' ? 'error' : 'end',
    input_refs: [input.worktreePath],
    output_refs: prUrl ? [prUrl] : [input.worktreePath],
    duration_ms: loopResult.duration_ms,
    cost_usd: loopResult.cost_usd,
    metadata: {
      outcome,
      iterations: loopResult.iterations,
      stop_reason: loopResult.stop_reason,
      gate_invocations: gateState.invocations,
      verdicts_summary: gateState.verdicts.map((v) => v.kind),
      tool_use: toolUseSummary,
      pr_url: prUrl,
    },
  });

  if (outcome === 'send-back-cap-exhausted') {
    throw new Error(
      `reviewer phase failed: send-back cap exhausted after ${gateState.invocations} rounds`,
    );
  }
  return outcome;
}

function newCycleId(initiativeId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}_${initiativeId}`;
}

/**
 * Boundary commit between dev-loop and reviewer phases. Catches any
 * uncommitted work from the dev-loop (the agent's per-iteration commit is
 * prompt-only, not enforced; this is the safety net). Best-effort —
 * `--allow-empty` so a no-op cycle doesn't error, and `|| true`-style
 * try/catch so non-git worktrees (e.g. early dry-runs) don't fail the cycle.
 */
function commitDevLoopBoundary(
  worktreePath: string,
  logger: EventLogger,
  initiativeId: string,
): void {
  try {
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        'commit',
        '--allow-empty',
        '-m',
        'chore(developer-loop): pre-review boundary snapshot',
      ],
      { cwd: worktreePath, stdio: 'pipe' },
    );
    logger.emit({
      initiative_id: initiativeId,
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'log',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'cycle.dev-boundary-commit',
    });
  } catch {
    // Not a git repo, or no changes to commit, or git failed — non-fatal.
  }
}
