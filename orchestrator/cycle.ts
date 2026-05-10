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
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  wipeRalphScratch,
  type ReviewerToolUseSummary,
} from './reviewer-invocation.ts';
import {
  REFLECTOR_ALLOWED_TOOLS,
  REFLECTOR_DISALLOWED_TOOLS,
  REFLECTOR_MODEL,
  buildReflectorSystemPrompt,
  renderReflectorUserPrompt,
  tallyToolUse as tallyReflectorToolUse,
  type ReflectorToolUseSummary,
} from './reflector-invocation.ts';
import {
  makeReviewerQualityGate,
  type GetVerdict,
  type ReviewerGateState,
} from './reviewer-stage2.ts';
import { moveTo as moveQueueItem } from './queue.ts';
import { notify } from './notify.ts';
import {
  detectHiddenCoupling,
  readWorkItemsFromDir,
  topologicalOrder,
  validateWorkItemSet,
  writeWorkItemStatus,
  type WorkItem,
} from './work-item.ts';
import { createClaudeAgent, type QueryFn } from '../loops/ralph/claude-agent.ts';
import { run as runRalph, type LoopResult } from '../loops/ralph/runner.ts';
import { makeQualityGateFromCmd } from '../loops/ralph/stop-conditions.ts';
import { writeCycleReport } from './cycle-report.ts';

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

export type ReflectionStatus = 'closed' | 'failed' | 'skipped';

export type CycleResult = {
  cycle_id: string;
  initiative_id: string;
  status: 'merged' | 'ready-for-review' | 'send-back-cap-exhausted' | 'failed';
  /**
   * Outcome of the reflection phase. Reflection runs after a successful merge
   * and is log-and-continue: a failed reflector does not change the merge
   * outcome (`status`). Surfaced as separate telemetry, not a cycle gate.
   *
   * - `closed`   — reflection ran to completion.
   * - `failed`   — reflection ran but threw.
   * - `skipped`  — reflection was not invoked (no merge, or dry run).
   */
  reflection_status?: ReflectionStatus;
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

  // F-04 / F-06: derive the effective quality-gate command once per cycle so
  // the dev-loop and reviewer use exactly the same gate. Precedence:
  //   1. CycleInput.qualityGateCmd (explicit override — bench harnesses use this)
  //   2. manifest.quality_gate_cmd (per-project config in initiative manifest)
  //   3. ['npm', 'test'] if the worktree has package.json
  //   4. ['true'] (no-op, tests bypassed) — only happens for non-Node repos
  //      that didn't declare a quality_gate_cmd; the dispatch will surface
  //      the absence via a metadata field.
  const effectiveQualityGateCmd = resolveQualityGateCmd(input);
  const inputWithGate: CycleInput = { ...input, qualityGateCmd: effectiveQualityGateCmd };

  let reviewerOutcome: ReviewerOutcome = 'ready-for-review';
  let reflectionStatus: ReflectionStatus = 'skipped';
  try {
    if (!input.dryRun) {
      await runProjectManager(inputWithGate, logger);
      await runDeveloperLoop(inputWithGate, logger);
      // Safety net: commit any uncommitted dev-loop work before the reviewer
      // starts. The dev-loop's prompt tells the agent to commit per
      // iteration, but if it skips, the reviewer's gh-shim does
      // `git reset --hard HEAD` and the source files vanish. This
      // boundary commit catches any drift. Files matching .gitignore
      // (Ralph scratch: PROMPT.md / AGENT.md / fix_plan.md, node_modules)
      // are excluded by `git add` automatically.
      commitDevLoopBoundary(inputWithGate.worktreePath, logger, inputWithGate.initiativeId);
      reviewerOutcome = await runReviewer(inputWithGate, logger);

      // Reflection: only fires after a successful merge. Log-and-continue —
      // a thrown reflector does not change the cycle's `status` (the merge
      // already happened; reflection cannot un-merge). Surface as separate
      // `reflection_status` telemetry instead.
      if (reviewerOutcome === 'merged') {
        reflectionStatus = await runReflector(inputWithGate, logger);
      }
    }
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
    reviewerOutcome = 'ready-for-review'; // sentinel; overridden below to 'failed'
    const result: CycleResult = {
      cycle_id: cycleId,
      initiative_id: input.initiativeId,
      status: 'failed',
      reflection_status: reflectionStatus,
      duration_ms: Date.now() - started,
      log_path: logger.logFilePath,
    };
    // Snapshot artefacts + write report even on failure — failed cycles
    // still produce useful evidence for diagnosis. AWAIT the snapshot so
    // the report's "decomposition" / "verification" sections find the
    // copied work-items + demo dirs (otherwise the report runs before the
    // copy completes and silently shows the no-snapshot fallback).
    await snapshotCycleArtefacts(input, cycleId).catch(() => { /* best-effort */ });
    writeCycleReportSafely(cycleId);
    return result;
  }

  // Success path (no throw). Snapshot before cycle.end so the report can
  // include the cycle.end metadata and reference durable artefacts.
  await snapshotCycleArtefacts(input, cycleId).catch(() => { /* best-effort */ });

  const result: CycleResult = {
    cycle_id: cycleId,
    initiative_id: input.initiativeId,
    status: reviewerOutcome,
    reflection_status: reflectionStatus,
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
    metadata: { status: result.status, reflection_status: result.reflection_status },
  });

  // Generate the human-facing report as the final cycle step. Best-effort —
  // a failed report write does not fail the cycle (the merge already
  // happened; the report is meta).
  writeCycleReportSafely(cycleId);

  return result;
}

/**
 * Snapshot ephemeral cycle artefacts from the worktree to durable
 * `_logs/<cycleId>/` paths so they survive `worktree.cleanup()` and are
 * available for the cycle report (and re-generation later).
 *
 * Best-effort: missing dirs are skipped silently, copy failures are
 * surfaced via the returned promise rejection so the caller can decide
 * whether to log them.
 */
async function snapshotCycleArtefacts(
  input: CycleInput,
  cycleId: string,
): Promise<void> {
  const forgeRoot = resolve(import.meta.dirname, '..');
  const cycleLogDir = resolve(forgeRoot, '_logs', cycleId);
  if (!existsSync(cycleLogDir)) mkdirSync(cycleLogDir, { recursive: true });

  // Work-item specs: the PM's output, valuable evidence for the report's
  // "How the system decomposed it" section.
  const wiSrc = resolve(input.worktreePath, '.forge', 'work-items');
  if (existsSync(wiSrc)) {
    const wiDst = resolve(cycleLogDir, 'work-items-snapshot');
    cpSync(wiSrc, wiDst, { recursive: true, force: true });
  }

  // Demo bundle: the reviewer's recording + source script + README. Real
  // showcase content for the report's "Verification" section.
  const demoSrc = resolve(input.worktreePath, '.forge', 'demos', input.initiativeId);
  if (existsSync(demoSrc)) {
    const demoDst = resolve(cycleLogDir, 'demo');
    cpSync(demoSrc, demoDst, { recursive: true, force: true });
  }

  // PR description draft: useful for the report's "What landed" section.
  const prSrc = resolve(input.worktreePath, '.forge', 'pr-description.md');
  if (existsSync(prSrc)) {
    cpSync(prSrc, resolve(cycleLogDir, 'pr-description.md'), { force: true });
  }
}

/**
 * Best-effort report write at end of cycle. Catches all errors so a failure
 * to render the report (missing data, malformed event log, etc.) cannot
 * fail the cycle itself — the merge has already happened by the time we
 * reach this point.
 */
function writeCycleReportSafely(cycleId: string): void {
  try {
    writeCycleReport({ cycleId });
  } catch (err) {
    process.stderr.write(
      `[cycle-report] failed to write report for ${cycleId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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

  // F-13 / F-19: enforce the brain-first mandate at the orchestrator. If the
  // PM agent skipped brain-query entirely, fail fast with a distinct error
  // (rather than continuing into validateWorkItemSet, where the
  // brain-skip's downstream effect — incomplete frontmatter — surfaces
  // instead, masking the real cause).
  if (
    !recordBrainGateResult('project-manager', 'project-manager', toolUseSummary.brainReads, {
      initiativeId: input.initiativeId,
      logger,
      parentEventId: start.event_id,
    })
  ) {
    throw new Error(
      'project-manager phase failed: brain-first mandate not honoured (0 brain-query calls). The system prompt requires reading from `brain/...` (forge themes + project themes) before producing work items.',
    );
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

  // F-05: hidden-coupling check. Two WIs whose `files_in_scope` overlap
  // without a `depends_on` edge between them will conflict at merge time.
  // The bench has scored this since pass-1; production didn't enforce it
  // until now. Failures here surface as a distinct error so the operator
  // sees the structural cause rather than a generic "PM phase failed".
  const couplingViolations = items.length > 0 ? detectHiddenCoupling(items) : [];

  const failed =
    items.length === 0 ||
    Object.keys(parseErrors).length > 0 ||
    setErrors.length > 0 ||
    itemErrorCount > 0 ||
    couplingViolations.length > 0;

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
      hidden_coupling_violations: couplingViolations,
    },
  });

  if (failed) {
    const summary = [
      items.length === 0 ? 'no work items emitted' : null,
      Object.keys(parseErrors).length > 0 ? `parse errors: ${Object.keys(parseErrors).join(', ')}` : null,
      setErrors.length > 0 ? `set errors: ${setErrors.join('; ')}` : null,
      itemErrorCount > 0 ? `${itemErrorCount} per-item validation errors` : null,
      couplingViolations.length > 0
        ? `${couplingViolations.length} hidden-coupling pair(s): ${couplingViolations.map((p) => `${p.a}↔${p.b} share ${p.sharedFiles.join(',')}`).join('; ')}`
        : null,
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
    const wiToolUse: DevToolUseSummary = { reads: 0, brainReads: 0, writes: 0, bashCalls: 0, testRuns: 0 };

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
          // F-04: thread the per-project quality-gate command into the
          // runner. When absent, runner falls back to its default
          // (`npm test --silent`); when present (resolveQualityGateCmd
          // populated it from manifest or a Node-repo default), the runner
          // uses the exact same command the reviewer will use.
          qualityGate: input.qualityGateCmd && input.qualityGateCmd.length > 0
            ? makeQualityGateFromCmd(input.worktreePath, input.qualityGateCmd)
            : undefined,
          // F-14: emit per-iteration events so metrics (cycle.ts:metrics.ts)
          // can aggregate iteration counts. Without this, `iterations_total`
          // was structurally always 0 even though the schema declared the
          // event_type.
          onIteration: (iteration, info) => {
            logger.emit({
              initiative_id: input.initiativeId,
              parent_event_id: wiStart.event_id,
              phase: 'developer-loop',
              skill: 'developer-ralph',
              event_type: 'iteration',
              iteration,
              input_refs: [specPath],
              output_refs: info.filesChanged,
              cost_usd: info.costUsd,
              metadata: { work_item_id: wi.work_item_id },
            });
          },
        },
        agent,
      );
    } catch (err) {
      runnerError = {
        kind: 'agent_threw',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // F-13: brain-first gate per WI. The dev-loop's per-WI try/catch above
    // already produces partial-failure semantics; mirror that here — record
    // the gate violation, mark the WI failed, let the cycle continue (other
    // independent WIs may still succeed; total dev-loop failure is checked
    // at the bottom of the loop).
    if (
      !runnerError &&
      !recordBrainGateResult('developer-loop', 'developer-ralph', wiToolUse.brainReads, {
        initiativeId: input.initiativeId,
        logger,
        parentEventId: wiStart.event_id,
        subject: wi.work_item_id,
      })
    ) {
      runnerError = {
        kind: 'brain-skipped',
        message: 'brain-first mandate not honoured for this WI (0 brain-query calls)',
      };
    }

    const finalStatus: WorkItem['status'] = runnerError
      ? 'failed'
      : result?.status === 'complete'
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
 *
 * Pushes the local branch to the remote first; `gh pr create` requires the
 * branch to exist on origin. W4 trial caught this — pre-fix, openPullRequest
 * called `gh pr create` without a push, which fails with "no pull requests
 * found" since the branch wasn't published.
 */
function openPullRequest(
  worktreePath: string,
  prDescriptionPath: string,
  title: string,
): string | null {
  try {
    // Determine the current branch in the worktree.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (!branch || branch === 'HEAD') return null;

    // Push to origin (set-upstream so gh pr create knows the head ref).
    // Failures here propagate to the catch — a non-pushable branch is a
    // genuine merge blocker, not a soft warning.
    execFileSync('git', ['push', '--set-upstream', 'origin', branch], {
      cwd: worktreePath,
      stdio: 'pipe',
    });

    const out = execFileSync(
      'gh',
      ['pr', 'create', '--body-file', prDescriptionPath, '--title', title],
      { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' },
    );
    const match = out.match(/https:\S+/);
    return match ? match[0] : out.trim() || null;
  } catch (err) {
    // Surface the failure on stderr so the operator sees what went wrong;
    // openPullRequest's nullable return is otherwise opaque.
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    if (stderr) process.stderr.write(`[openPullRequest] ${stderr}\n`);
    else if (e.message) process.stderr.write(`[openPullRequest] ${e.message}\n`);
    return null;
  }
}

/**
 * Best-effort `gh pr merge` for the approved PR. Returns true on success.
 * The PR-create + PR-merge split lets bench-mode use a `gh` shim that
 * records the operations locally without touching real GitHub.
 *
 * Notably does NOT pass `--delete-branch`: that flag makes `gh` switch the
 * project repo's HEAD to main and `git branch -D` the merged branch, which
 * fails when the project repo already has main checked out at
 * `projects/<name>/` (a forge worktree was added off the same repo). Branch
 * cleanup is owned by `worktree.cleanup()` in the scheduler's finally
 * block (F-09) — local branch deleted there, remote branch lingers
 * unless the GitHub repo has "auto-delete head branches" enabled.
 */
function mergePullRequest(worktreePath: string): boolean {
  try {
    execFileSync('gh', ['pr', 'merge', '--merge'], {
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

  // F-15: wipe the dev-loop's leftover PROMPT.md / AGENT.md / fix_plan.md
  // before stamping the reviewer's. The dev-loop's stamps are per-WI scratch
  // state for THAT phase; the review-Ralph is a different mission with a
  // different iteration prompt. Without this, prepareReviewerWorkspace's
  // idempotency would leave the agent reading stale dev-loop content and
  // hallucinating its role. Logic extracted to `wipeRalphScratch` in
  // reviewer-invocation.ts for direct unit testing.
  wipeRalphScratch(input.worktreePath);

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
        // F-14: emit per-iteration events for the reviewer-Ralph as well.
        onIteration: (iteration, info) => {
          logger.emit({
            initiative_id: input.initiativeId,
            parent_event_id: start.event_id,
            phase: 'review-loop',
            skill: 'reviewer',
            event_type: 'iteration',
            iteration,
            input_refs: [input.worktreePath],
            output_refs: info.filesChanged,
            cost_usd: info.costUsd,
          });
        },
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

  // F-13: brain-first gate. The reviewer is supposed to consult brain themes
  // for PR/demo conventions and project review gotchas before drafting.
  // A skipped consultation is a hard fail UNLESS the loop also exhausted
  // its iteration budget — in that case the agent ran out of rounds while
  // working (a PR draft and demo do exist), so the F-11 cap-exhausted path
  // should still move the manifest to `ready-for-review/` for operator
  // pickup. The brain-skipped event is recorded for visibility either way.
  const brainOk = recordBrainGateResult('review-loop', 'reviewer', toolUseSummary.brainReads, {
    initiativeId: input.initiativeId,
    logger,
    parentEventId: start.event_id,
  });
  if (!brainOk && loopResult.stop_reason !== 'iteration-budget') {
    throw new Error(
      'review-loop phase failed: brain-first mandate not honoured (0 brain-query calls). The reviewer must read project themes before drafting the demo + PR.',
    );
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
    // Prefer a human-readable PR title pulled from the PR description's
    // first heading. Falls back to the initiative ID when the description
    // is absent or malformed (machine-readable but at least scoped to the
    // initiative — better than the worktree's basename).
    const prTitle = extractPrTitle(prDescriptionPath, input.initiativeId);
    prUrl = openPullRequest(input.worktreePath, prDescriptionPath, prTitle);
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
    // F-11: send-back cap exhausted is NOT a phantom value any more. Move the
    // manifest to `ready-for-review/` so the operator can pick up via
    // `forge review` (PR draft exists; the agent ran out of send-back rounds
    // before reaching an approved verdict). Return outcome cleanly — the
    // dispatch helper notifies as 'failed' to surface the cap exhaustion.
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
    try {
      moveQueueItem(basename(input.manifestPath), 'ready-for-review');
    } catch {
      /* best-effort — manifest may already have been moved */
    }
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

  // F-11: removed the throw on `send-back-cap-exhausted` — manifest is already
  // moved to `ready-for-review/` above and the cycle returns the status
  // cleanly. The scheduler dispatch handles the 'send-back-cap-exhausted'
  // status as a failed-with-PR-draft case (operator picks up via
  // `forge review <id>`).
  return outcome;
}

/**
 * Defaults for the live reflector invocation. The reflector is a one-shot SDK
 * call (not a Ralph loop) that consumes the cycle's event log + manifest +
 * merged tree and emits brain theme writes. The bench's 5-fixture median is
 * ~$0.74/run; the live cap gives 2x headroom for richer real cycles.
 */
const REFLECTOR_LIVE_MAX_TURNS = 60;
const REFLECTOR_LIVE_MAX_BUDGET_USD = 1.5;

/**
 * Reflection phase. Runs after a successful merge to extract patterns from the
 * cycle's event log + merged tree into brain themes. Closes the learning loop.
 *
 * Failure mode: log-and-continue. A thrown reflector returns `'failed'`
 * but does not propagate — the merge already happened in `runReviewer`,
 * and reflection cannot un-merge.
 *
 * Live invocation contract is shared with the bench via
 * orchestrator/reflector-invocation.ts (single source of truth).
 */
async function runReflector(
  input: CycleInput,
  logger: EventLogger,
): Promise<ReflectionStatus> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'start',
    input_refs: [input.manifestPath, logger.logFilePath],
    output_refs: [],
    message: 'reflector.start',
  });

  const forgeRoot = resolve(import.meta.dirname, '..');
  const cycleId = logger.cycleId;
  const cycleLogDir = resolve(forgeRoot, '_logs', cycleId);

  // Reflection runs after the reviewer merged the initiative, which moves the
  // manifest from `_queue/in-flight/` to `_queue/done/`. The cycle was kicked
  // off with the in-flight path, so we look up the current location before
  // reading. Fall back to the original path so this stays compatible with
  // bench harnesses that point directly at a stable manifest.
  const manifestPath = resolveCurrentManifestPath(input.manifestPath, forgeRoot);

  let projectName: string;
  try {
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    projectName = manifest.project;
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'error',
      input_refs: [manifestPath],
      output_refs: [],
      message: 'reflector.manifest-unreadable',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return 'failed';
  }

  const systemPrompt = buildReflectorSystemPrompt(forgeRoot);
  const cycleArchivePath = resolve(forgeRoot, 'brain', '_raw', 'cycles', `${cycleId}.md`);
  const themesDir = resolve(forgeRoot, 'brain', 'projects', projectName, 'themes');
  // F-07: ensure brain destination dirs exist before invoking the SDK; the
  // reflector writes here directly. A first-time project (no themes/ yet) or
  // a fresh forge install (no brain/_raw/cycles/) would otherwise see ENOENT
  // inside the agent and silently log-and-continue-fail.
  mkdirSync(resolve(forgeRoot, 'brain', '_raw', 'cycles'), { recursive: true });
  mkdirSync(themesDir, { recursive: true });
  // F-12: touch brain-gaps.jsonl if absent. The reflector's user prompt
  // points it at this file; the bench fixtures pre-populate it. In live
  // cycles, gaps are agent-driven (brain-query SKILL writes to it). For the
  // production path, an empty file is a valid signal of "no gaps recorded
  // this cycle" — better than ENOENT bouncing the agent's Read attempt.
  // A real orchestrator-side gap producer is deferred to pass-3 (would
  // require post-cycle event-log scanning).
  const brainGapsPath = resolve(cycleLogDir, 'brain-gaps.jsonl');
  if (!existsSync(brainGapsPath)) {
    mkdirSync(cycleLogDir, { recursive: true });
    writeFileSync(brainGapsPath, '');
  }
  const prompt = renderReflectorUserPrompt({
    initiativeId: input.initiativeId,
    cycleId,
    manifestRelPath: manifestPath,
    eventLogRelPath: logger.logFilePath,
    brainGapsRelPath: resolve(cycleLogDir, 'brain-gaps.jsonl'),
    mergedTreeRelPath: input.projectRepoPath,
    projectName,
    userQuestionsRelPath: resolve(cycleLogDir, 'user-questions.md'),
    userFeedbackRelPath: resolve(cycleLogDir, 'user-feedback.md'),
    retroRelPath: resolve(cycleLogDir, 'retro.md'),
    cycleArchiveRelPath: cycleArchivePath,
    themesDirRelPath: themesDir,
  });

  const options: Record<string, unknown> = {
    cwd: forgeRoot,
    systemPrompt,
    model: REFLECTOR_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: [...REFLECTOR_ALLOWED_TOOLS],
    disallowedTools: [...REFLECTOR_DISALLOWED_TOOLS],
    maxTurns: REFLECTOR_LIVE_MAX_TURNS,
    maxBudgetUsd: REFLECTOR_LIVE_MAX_BUDGET_USD,
  };

  const toolUseSummary: ReflectorToolUseSummary = {
    brainReads: 0,
    themeWrites: 0,
    retroWrites: 0,
    bashCalls: 0,
  };
  let costUsd = 0;
  let durationMs = 0;
  let resultSubtype: string | undefined;

  try {
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
        tallyReflectorToolUse(m.message, toolUseSummary);
        continue;
      }
      if (m.type !== 'result') continue;
      if (typeof m.duration_ms === 'number') durationMs = m.duration_ms;
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
      resultSubtype = m.subtype ?? 'success';
      break;
    }
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'reflection',
      skill: 'reflector',
      event_type: 'error',
      input_refs: [logger.logFilePath],
      output_refs: [],
      message: 'reflector.crashed',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return 'failed';
  }

  // F-13: brain-first gate for reflector. Log-and-continue style — reflector
  // failures don't propagate (the merge already happened). The
  // reflection_status field surfaces the failure to telemetry.
  if (
    !recordBrainGateResult('reflection', 'reflector', toolUseSummary.brainReads, {
      initiativeId: input.initiativeId,
      logger,
      parentEventId: start.event_id,
    })
  ) {
    return 'failed';
  }

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'reflection',
    skill: 'reflector',
    event_type: 'end',
    input_refs: [logger.logFilePath, manifestPath],
    output_refs: [resolve(cycleLogDir, 'retro.md')],
    cost_usd: costUsd,
    duration_ms: durationMs,
    message: 'reflector.end',
    metadata: {
      status: 'closed',
      project: projectName,
      result_subtype: resultSubtype,
      tool_use: toolUseSummary,
    },
  });
  return 'closed';
}

function newCycleId(initiativeId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}_${initiativeId}`;
}

/**
 * Extract a human-readable PR title from the reviewer's pr-description.md.
 * The reviewer convention is `# <title>` as the first line; we pluck that.
 * Falls back to the initiativeId if the file is missing/malformed/empty.
 */
function extractPrTitle(prDescriptionPath: string, initiativeId: string): string {
  try {
    const content = readFileSync(prDescriptionPath, 'utf8');
    const match = content.match(/^#\s+(.+)$/m);
    if (match && match[1].trim().length > 0) return match[1].trim();
  } catch {
    /* fall through */
  }
  return initiativeId;
}

/**
 * Resolve the quality-gate command the dev-loop runner and reviewer will use.
 * Single source of truth — both phases call this and use the same vector.
 *
 * Precedence: explicit CycleInput → manifest field → npm test (if Node repo)
 * → ['true'] (no-op for non-Node repos that didn't declare a command).
 */
function resolveQualityGateCmd(input: CycleInput): string[] {
  if (input.qualityGateCmd && input.qualityGateCmd.length > 0) {
    return [...input.qualityGateCmd];
  }
  try {
    const m = parseManifest(readFileSync(input.manifestPath, 'utf8'));
    if (m.quality_gate_cmd && m.quality_gate_cmd.length > 0) {
      return [...m.quality_gate_cmd];
    }
  } catch {
    /* manifest may not exist in dry-run / test fixtures; fall through */
  }
  if (existsSync(resolve(input.worktreePath, 'package.json'))) {
    return ['npm', 'test'];
  }
  return ['true'];
}

/**
 * Brain-first runtime gate. CLAUDE.md and every SKILL.md require each phase's
 * agent to consult the brain (via `Read`/`Grep`/`Glob` against `brain/...`)
 * before producing output. Bench harnesses gate on this; production didn't —
 * which surfaced in W4 as a PM run that fabricated a "Brain themes consulted"
 * footer while the tool-use summary recorded `brainReads: 0`.
 *
 * Returns true iff the agent consulted the brain at least once. On false,
 * emits a `<skill>.brain-skipped` error event so the failure is observable;
 * the caller decides whether to throw (PM/review) or log-and-continue
 * (dev-loop per-WI / reflector — both have established graceful paths).
 */
export function recordBrainGateResult(
  phase: 'project-manager' | 'developer-loop' | 'review-loop' | 'reflection',
  skill: string,
  brainReads: number,
  context: {
    initiativeId: string;
    logger: EventLogger;
    parentEventId?: string;
    subject?: string;
  },
): boolean {
  if (brainReads > 0) return true;
  context.logger.emit({
    initiative_id: context.initiativeId,
    parent_event_id: context.parentEventId,
    phase,
    skill,
    event_type: 'error',
    input_refs: [],
    output_refs: [],
    message: `${skill}.brain-skipped`,
    metadata: context.subject ? { subject: context.subject } : undefined,
  });
  return false;
}

/**
 * Resolve the current location of an initiative's manifest. The reviewer
 * moves the manifest from `_queue/in-flight/` to `_queue/done/` (or
 * `_queue/ready-for-review/`) on completion. Reflection runs *after* the
 * move, so reading the original `input.manifestPath` ENOENTs every real
 * cycle. We look at the queue's terminal states first, then fall back to
 * the original path so bench harnesses (which pass a stable, non-queue path)
 * still work.
 */
function resolveCurrentManifestPath(originalPath: string, forgeRoot: string): string {
  if (existsSync(originalPath)) return originalPath;
  const filename = basename(originalPath);
  const candidates = [
    resolve(forgeRoot, '_queue', 'done', filename),
    resolve(forgeRoot, '_queue', 'ready-for-review', filename),
    resolve(forgeRoot, '_queue', 'failed', filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return originalPath;
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
