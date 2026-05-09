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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  renderReviewerUserPrompt,
  tallyToolUse as tallyReviewerToolUse,
  type ReviewerToolUseSummary,
} from './reviewer-invocation.ts';
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
};

export type CycleResult = {
  cycle_id: string;
  initiative_id: string;
  status: 'ready-for-review' | 'failed';
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

  try {
    if (!input.dryRun) {
      await runProjectManager(input, logger);
      await runDeveloperLoop(input, logger);
      await runReviewer(input, logger);
    }

    const result: CycleResult = {
      cycle_id: cycleId,
      initiative_id: input.initiativeId,
      status: 'ready-for-review',
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

  if (completeCount < items.length) {
    throw new Error(
      `developer-loop: ${items.length - completeCount}/${items.length} work items did not complete`,
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
 * Defaults for the live reviewer (stage 1, review-prep). One-shot SDK call —
 * the agent reads completed WIs, records a demo, and drafts a PR description.
 * The orchestrator runs the quality gate, opens the real PR via `gh`, moves
 * the manifest to ready-for-review, and fires the notification.
 *
 * Higher per-fixture USD cap than the bench (live worktrees are richer); the
 * bench tightens to 0.6 USD / 50 turns to surface efficiency regressions.
 */
const REVIEWER_LIVE_MAX_TURNS = 60;
const REVIEWER_LIVE_MAX_BUDGET_USD = 1.0;
const PR_DESCRIPTION_REL_PATH = '.forge/pr-description.md';
const DEMO_DIR_REL_PATH = '.forge/demos';

/**
 * Infer project type from the worktree contents. Used to give the reviewer
 * agent the right demo-tool default in its user prompt.
 */
function inferProjectType(worktreePath: string): 'browser' | 'cli' | 'lib' | 'rest' {
  if (existsSync(resolve(worktreePath, 'playwright.config.ts')) ||
      existsSync(resolve(worktreePath, 'playwright.config.js'))) {
    return 'browser';
  }
  if (existsSync(resolve(worktreePath, 'index.html'))) return 'browser';
  if (existsSync(resolve(worktreePath, 'openapi.yaml')) ||
      existsSync(resolve(worktreePath, 'openapi.json'))) {
    return 'rest';
  }
  if (existsSync(resolve(worktreePath, 'bin')) ||
      existsSync(resolve(worktreePath, 'cmd'))) {
    return 'cli';
  }
  return 'lib';
}

/**
 * Run the project's quality gate command. The reviewer agent's claim of
 * "tests pass" is not trusted — the orchestrator re-runs the gate post-agent
 * and refuses to open the PR if it fails. Mirrors the developer-loop's
 * `quality-gates-orchestrator-verified` discipline.
 *
 * Returns true iff the command exits 0 in the worktree.
 */
function runReviewerQualityGate(worktreePath: string, cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

async function runReviewer(input: CycleInput, logger: EventLogger): Promise<void> {
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
  // Default quality gate: prefer `npm test` if package.json present, else
  // a no-op `true` so the reviewer at least drafts the PR. Operators wire
  // project-specific gates in the future via initiative-manifest metadata.
  const qualityGateCmd =
    existsSync(resolve(input.worktreePath, 'package.json'))
      ? ['npm', 'test']
      : ['true'];

  const systemPrompt = buildReviewerSystemPrompt(forgeRoot);
  const prompt = renderReviewerUserPrompt({
    initiativeId: input.initiativeId,
    manifestRelPath: input.manifestPath,
    worktreeRelPath: input.worktreePath,
    projectName: basename(input.worktreePath),
    projectType,
    qualityGateCmd: qualityGateCmd.join(' '),
    isStackedPr: false,
  });

  const options: Record<string, unknown> = {
    cwd: forgeRoot,
    systemPrompt,
    model: REVIEWER_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: REVIEWER_ALLOWED_TOOLS,
    disallowedTools: REVIEWER_DISALLOWED_TOOLS,
    maxTurns: REVIEWER_LIVE_MAX_TURNS,
    maxBudgetUsd: REVIEWER_LIVE_MAX_BUDGET_USD,
  };

  const toolUseSummary: ReviewerToolUseSummary = {
    brainReads: 0,
    writes: 0,
    bashCalls: 0,
    recorderInvocations: 0,
  };
  let costUsd = 0;
  let durationMs = 0;
  let resultSubtype: string | undefined;

  for await (const msg of sdkQuery({ prompt, options }) as AsyncIterable<unknown>) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as {
      type?: string;
      message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
      subtype?: string;
      total_cost_usd?: number;
      duration_ms?: number;
    };
    if (m.type === 'assistant') {
      tallyReviewerToolUse(m.message, toolUseSummary);
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
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'tool_use',
      input_refs: ['brain/'],
      output_refs: [],
      message: 'reviewer.brain-query',
    });
  }

  // Orchestrator-verified quality gate. The reviewer's claim is not trusted.
  const qualityGatesPassed = runReviewerQualityGate(input.worktreePath, qualityGateCmd);
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: 'log',
    input_refs: [input.worktreePath],
    output_refs: [],
    message: 'reviewer.quality-gates-checked',
    metadata: { passed: qualityGatesPassed, command: qualityGateCmd.join(' ') },
  });

  const prDescriptionPath = resolve(input.worktreePath, PR_DESCRIPTION_REL_PATH);
  const demoDir = resolve(input.worktreePath, DEMO_DIR_REL_PATH, input.initiativeId);
  const prDraftWritten = existsSync(prDescriptionPath);
  const demoBundlePresent = existsSync(demoDir);

  if (prDraftWritten) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [prDescriptionPath],
      message: 'reviewer.pr-description-emitted',
      metadata: { bytes: statSync(prDescriptionPath).size },
    });
  }
  if (demoBundlePresent) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [demoDir],
      message: 'reviewer.demo-recorded',
    });
  }

  // Side-effecting work — only proceeds when both gates are green AND a PR
  // draft was written. Anything else is a failed review-prep.
  const failed = !qualityGatesPassed || !prDraftWritten;
  let prUrl: string | null = null;

  if (!failed) {
    prUrl = openPullRequest(input.worktreePath, prDescriptionPath);
    if (prUrl) {
      logger.emit({
        initiative_id: input.initiativeId,
        parent_event_id: start.event_id,
        phase: 'review-loop',
        skill: 'reviewer',
        event_type: 'log',
        input_refs: [prDescriptionPath],
        output_refs: [prUrl],
        message: 'reviewer.pr-opened',
        metadata: { url: prUrl },
      });
    }

    // Move manifest from in-flight to ready-for-review and fire the
    // notification (per ADR 013). Best-effort — failures here surface in the
    // event log rather than blocking the cycle.
    try {
      const manifestFilename = basename(input.manifestPath);
      moveQueueItem(manifestFilename, 'ready-for-review');
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
          body: prUrl ? `PR ready: ${prUrl}` : 'PR draft ready in .forge/pr-description.md',
          url: prUrl ?? undefined,
          metadata: { initiative_id: input.initiativeId },
        },
        { desktop: true, webhook_url: null },
      );
      logger.emit({
        initiative_id: input.initiativeId,
        parent_event_id: start.event_id,
        phase: 'review-loop',
        skill: 'reviewer',
        event_type: 'log',
        input_refs: [],
        output_refs: [],
        message: 'reviewer.notify-sent',
      });
    } catch {
      // notify() is already best-effort; nothing to do.
    }
  }

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: failed ? 'error' : 'end',
    input_refs: [input.worktreePath],
    output_refs: prUrl ? [prUrl, demoDir] : [demoDir],
    duration_ms: durationMs,
    cost_usd: costUsd,
    metadata: {
      result_subtype: resultSubtype,
      tool_use: toolUseSummary,
      quality_gates_passed: qualityGatesPassed,
      pr_draft_written: prDraftWritten,
      demo_bundle_present: demoBundlePresent,
      pr_url: prUrl,
    },
  });

  if (failed) {
    const reasons = [
      !qualityGatesPassed ? `quality gates failed (${qualityGateCmd.join(' ')})` : null,
      !prDraftWritten ? 'pr-description.md not written' : null,
    ]
      .filter((s): s is string => s !== null)
      .join('; ');
    throw new Error(`reviewer phase failed: ${reasons}`);
  }
}

function newCycleId(initiativeId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}_${initiativeId}`;
}
