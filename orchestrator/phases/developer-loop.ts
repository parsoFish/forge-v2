/**
 * Developer-loop phase runner. Extracted from cycle.ts (Phase 3.4c step 4).
 *
 * Walks the work items in topological order, running a Ralph loop per WI and
 * skipping dependents of failed prerequisites. Behaviour is identical to the
 * prior in-cycle implementation — this module only relocates the code so the
 * orchestration spine stays thin.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { EventLogger } from '../logging.ts';
import {
  DEV_ALLOWED_TOOLS,
  DEV_DISALLOWED_TOOLS,
  DEV_MODEL,
  buildDevSystemPrompt,
  prepareDevWorkspace,
  tallyToolUse as tallyDevToolUse,
  type DevToolUseSummary,
} from '../dev-invocation.ts';
import {
  readWorkItemsFromDir,
  topologicalOrder,
  validateWorkItemSet,
  writeWorkItemStatus,
  type WorkItem,
} from '../work-item.ts';
import { createClaudeAgent, type QueryFn } from '../../loops/ralph/claude-agent.ts';
import { run as runRalph, type LoopResult } from '../../loops/ralph/runner.ts';
import { makeQualityGateFromCmd, type GateRunInfo } from '../../loops/ralph/stop-conditions.ts';
import { assertLocalRemoteSynced, checkLocalRemoteSynced, pushInitiativeBranch } from '../pr.ts';
import {
  buildUnifierSystemPrompt,
  prepareUnifierWorkspace,
  UNIFIER_ALLOWED_TOOLS,
  UNIFIER_DEFAULT_ITERATION_CAP,
  UNIFIER_DISALLOWED_TOOLS,
  UNIFIER_MODEL,
} from '../unifier-invocation.ts';
import { loadProjectConfig, type ProjectConfig } from '../project-config.ts';
import type { CycleInput } from '../cycle-context.ts';

/**
 * Wipe the Ralph scratch files (PROMPT.md / AGENT.md / fix_plan.md) so the
 * next sub-phase doesn't inherit stale state. Inlined here after the
 * reviewer-invocation.ts deletion (S4).
 */
function wipeRalphScratch(worktreePath: string): void {
  for (const f of ['PROMPT.md', 'AGENT.md', 'fix_plan.md']) {
    const p = join(worktreePath, f);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Defaults for the live Ralph loop. Per CONTRACTS.md C19, the per-WI $1.0 USD
 * cap that previously lived here has been REMOVED — iteration cap is the
 * only bound on the dev-loop. Cost is still logged per event for telemetry,
 * but no $-threshold gate exists. The per-iteration turn cap stays as a
 * runtime safety bound (not a budget).
 */
const DEV_LIVE_DEFAULT_ITERATIONS_PER_WI = 5;
const DEV_LIVE_MAX_TURNS_PER_ITERATION = 25;

export async function runDeveloperLoop(input: CycleInput, logger: EventLogger): Promise<void> {
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
  const forgeRoot = resolve(import.meta.dirname, '..', '..');
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

    // F-40: wipe AGENT.md / fix_plan.md / PROMPT.md between WIs. The dev-loop
    // runs N WIs sequentially against the same worktree; without this, WI-2's
    // agent inherits WI-1's institutional memory and ticked-off fix_plan,
    // looks at the satisfied checklist, and exits immediately with "all ACs
    // verified" — never reading its own WI.md. Reviewer already calls
    // wipeRalphScratch for the same reason (different role, different state);
    // the dev-loop needs the same treatment per WI. Diagnosed from the
    // 2026-05-10T21:32 cycle where WI-2..7 had 0 writes each because the
    // agent read WI-1.md, not WI-2.md.
    wipeRalphScratch(input.worktreePath);

    prepareDevWorkspace({
      initiativeId: input.initiativeId,
      workItemSpecPath: specPath,
      workItemSpecRelPath: `.forge/work-items/${wi.work_item_id}.md`,
      worktreePath: input.worktreePath,
      iterationBudget: wi.estimated_iterations > 0
        ? Math.max(wi.estimated_iterations, DEV_LIVE_DEFAULT_ITERATIONS_PER_WI)
        : DEV_LIVE_DEFAULT_ITERATIONS_PER_WI,
      // Per CONTRACTS.md C19: no $ cap. Carries through to the prompt header
      // as Infinity so the agent sees "no $ ceiling — iteration cap is the
      // only bound".
      costBudgetUsd: Number.POSITIVE_INFINITY,
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
      // Per CONTRACTS.md C19: no $ cap on the per-WI Ralph.
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
            // Per CONTRACTS.md C19: no $ cap. Pass Infinity so the runner's
            // cost-budget stop condition never fires.
            usd: Number.POSITIVE_INFINITY,
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
            ? makeQualityGateFromCmd(
                input.worktreePath,
                input.qualityGateCmd,
                (gateInfo) => emitGateEvent(logger, input.initiativeId, wiStart.event_id, wi.work_item_id, gateInfo),
              )
            : undefined,
          // F-14: emit per-iteration events so metrics (cycle.ts:metrics.ts)
          // can aggregate iteration counts. F-23 enriches the metadata so
          // post-mortems can see what the agent actually did per iteration
          // (which tools, which bash commands, last assistant text, tokens).
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
              tokens_in: info.tokensIn,
              tokens_out: info.tokensOut,
              metadata: {
                work_item_id: wi.work_item_id,
                tools_used: info.toolsUsed,
                bash_commands: info.bashCommands,
                last_assistant_text: info.lastAssistantText,
              },
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

    // F-34b: brain-first runtime gate REMOVED from the dev-loop. Brain
    // context is for design (architect / PM / reflector); the dev agent's
    // job is to make the WI's acceptance criteria observable using
    // files_in_scope and existing project code. Forcing the agent to read
    // brain themes was making it anchor on cross-cutting forge-system
    // patterns instead of focusing on the WI, producing trivial-pass exits
    // (see WI-2 of the 12:01 simplification-tests cycle). brainReads are
    // still TALLIED for telemetry — just no longer gated.
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

    // G8: push the initiative branch to origin after every WI so local ==
    // remote throughout the dev-loop (no divergence → no stacked-PR merge
    // conflict at the review boundary). The agent's per-iteration commit
    // (backstopped by commitDevLoopBoundary) is already on the branch;
    // publishing it now keeps origin in lock-step. Best-effort by return
    // value — the hard invariant is asserted once at close (below).
    const push = pushInitiativeBranch(input.worktreePath);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: wiStart.event_id,
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: push.pushed ? 'log' : 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: push.pushed ? 'dev-loop.branch-pushed' : 'dev-loop.branch-push-failed',
      metadata: push.pushed
        ? { work_item_id: wi.work_item_id, branch: push.branch }
        : { work_item_id: wi.work_item_id, reason: push.reason },
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
  // emit the partial outcome and hand off to the unifier.
  if (completeCount === 0 && items.length > 0) {
    throw new Error(
      `developer-loop: 0/${items.length} work items completed — total failure`,
    );
  }

  // S4: run the unifier sub-phase. The unifier owns the initiative-level
  // ACs, the tracked demo bundle, and the PR description. It runs once per
  // dev-loop (initial-prep mode) or once per send-back round
  // (`--feedback-ref` mode triggered by the review router). The Ralph
  // runner is reused with a different system prompt + iteration cap +
  // composed quality gates. Failures are classified per council 04 F7:
  //   - dev-loop-unifier-gate-failed
  //   - dev-loop-unifier-demo-failed
  //   - dev-loop-unifier-branch-divergence
  await runUnifier(input, logger, start.event_id);

  // S1.3: at dev-loop close the local↔remote invariant MUST hold —
  // `origin/<branch>` == local HEAD AND `main` == merge-base. A per-WI
  // push could have failed silently mid-loop (transient network blip),
  // and the reviewer + the rest of the cycle assume the branch is fully
  // published. A divergence here is a hard, classified failure: emit a
  // `dev-loop.branch-divergence` event and re-throw — the cycle's
  // try/catch + failure classifier handle the rest.
  //
  // Note: `cycle.ts:enforceDevLoopCloseInvariant` ALSO asserts this same
  // invariant immediately after `runDeveloperLoop` returns. The two calls
  // are deliberately additive (not duplicative): this one is the
  // dev-loop-PHASE'S own boundary check (phase-scoped event), the
  // cycle-level one runs AFTER `commitDevLoopBoundary` may have added
  // one more commit + push. Both are idempotent reads against git state.
  assertDevLoopCloseSync(input.worktreePath, logger, input.initiativeId);
}

/**
 * S1.3 — dev-loop close-step local↔remote invariant assertion.
 *
 * On OK: emits a `dev-loop.branch-sync-ok` log event (with ref hashes for
 * post-mortem) and returns.
 * On divergence: emits a `dev-loop.branch-divergence` error event (same
 * metadata shape) and re-throws the underlying `assertLocalRemoteSynced`
 * error. Caller decides what to do — the cycle's try/catch + failure
 * classifier consume the event.
 *
 * Exported for unit testing (real tmp git repos — see
 * `developer-loop-close-sync.test.ts`). Production callers should reach
 * this only via `runDeveloperLoop`'s close path.
 */
export function assertDevLoopCloseSync(
  worktreePath: string,
  logger: EventLogger,
  initiativeId: string,
): void {
  try {
    const inv = assertLocalRemoteSynced(worktreePath);
    logger.emit({
      initiative_id: initiativeId,
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'log',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'dev-loop.branch-sync-ok',
      metadata: {
        branch: inv.branch,
        local_head: inv.localHead,
        origin_head: inv.originHead,
        main_head: inv.mainHead,
        merge_base: inv.mergeBase,
        detail: inv.detail,
      },
    });
  } catch (err) {
    // Capture the ref-hash snapshot for the event BEFORE re-throwing so
    // post-mortems can see what diverged without re-running git from the
    // (possibly cleaned-up) worktree.
    const inv = checkLocalRemoteSynced(worktreePath);
    logger.emit({
      initiative_id: initiativeId,
      phase: 'developer-loop',
      skill: 'developer-ralph',
      event_type: 'error',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'dev-loop.branch-divergence',
      metadata: {
        branch: inv.branch,
        local_head: inv.localHead,
        origin_head: inv.originHead,
        main_head: inv.mainHead,
        merge_base: inv.mergeBase,
        detail: inv.detail,
        error_message: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
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
 * F-23: emit a `gate` event with the captured stdout/stderr/exit details from
 * a quality-gate run. The dev-loop's prior visibility into the gate was a
 * single boolean per iteration, swallowing the actual reason for failure;
 * this surfaces the truncated output so post-mortems can answer "why did the
 * gate fail" without re-running the worktree.
 */
function emitGateEvent(
  logger: EventLogger,
  initiativeId: string,
  parentEventId: string,
  workItemId: string,
  info: GateRunInfo,
): void {
  logger.emit({
    initiative_id: initiativeId,
    parent_event_id: parentEventId,
    phase: 'developer-loop',
    skill: 'developer-ralph',
    event_type: info.passed ? 'log' : 'error',
    input_refs: [],
    output_refs: [],
    duration_ms: info.durationMs,
    message: info.passed ? 'gate.pass' : 'gate.fail',
    metadata: {
      work_item_id: workItemId,
      gate_passed: info.passed,
      gate_exit_code: info.exitCode,
      gate_command: info.command,
      gate_stdout_tail: info.stdoutTail,
      gate_stderr_tail: info.stderrTail,
    },
  });
}

/**
 * S4 — run the developer-unifier sub-phase. Treats the initiative as one PR;
 * proves every AC against branch tip; authors demo + PR body; pushes; asserts
 * branch sync. The unifier reuses the Ralph runner with:
 *
 *   - System prompt: `buildUnifierSystemPrompt()` (SKILL.md + Ralph discipline)
 *   - Iteration cap: 3 (per CONTRACTS.md C19; no $ cap)
 *   - Quality gate: a composed `unifierQualityGate` checking all four
 *     gates (initiative, demo, pr-self-contained, branches-in-sync).
 *
 * In send-back mode (`input.unifierFeedbackRef` set per C3b), the prompt is
 * augmented and the iteration cap reset — every nudge is a fresh 3-iter run.
 *
 * Failure classification per council 04 F7:
 *   - dev-loop-unifier-gate-failed
 *   - dev-loop-unifier-demo-failed
 *   - dev-loop-unifier-branch-divergence
 *
 * Log-and-continue on failure: the cycle still proceeds to closure so the
 * operator sees the state via `forge review --inspect`. The failure event
 * is the diagnostic record.
 */
export async function runUnifier(
  input: CycleInput,
  logger: EventLogger,
  parentEventId: string,
): Promise<void> {
  // Wipe per-WI scratch files before stamping the unifier's prompts. The
  // unifier is a fresh mission with a different role; without this the
  // agent would inherit the last WI's ticked checklist.
  wipeRalphScratch(input.worktreePath);

  // Load the project config (mandatory per CONTRACTS.md C1 + council 04 F8).
  // The config tells the unifier which demo.shape to author and which
  // quality_gate_cmd to run.
  let projectConfig: ProjectConfig | null = null;
  try {
    projectConfig = loadProjectConfig(input.projectRepoPath);
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: parentEventId,
      phase: 'developer-loop',
      skill: 'developer-unifier',
      event_type: 'error',
      input_refs: [input.projectRepoPath],
      output_refs: [],
      message: 'unifier.project-config-invalid',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    // Fall through with projectConfig=null; the gate emits a classified
    // failure event below when it tries to use the demo command.
  }

  const demoShape = projectConfig?.demo.shape ?? 'none';
  const qualityGateCmd =
    projectConfig?.quality_gate_cmd ??
    input.qualityGateCmd ??
    (['npm', 'test'] as string[]);
  const feedbackRef = input.unifierFeedbackRef;

  const start = logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: parentEventId,
    phase: 'developer-loop',
    skill: 'developer-unifier',
    event_type: 'start',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
    message: feedbackRef ? 'unifier.start (send-back)' : 'unifier.start',
    metadata: { demo_shape: demoShape, feedback_ref: feedbackRef ?? null },
  });

  // Stamp PROMPT.md / AGENT.md / fix_plan.md for the unifier.
  const { promptPath } = prepareUnifierWorkspace({
    initiativeId: input.initiativeId,
    manifestRelPath: input.manifestPath,
    worktreePath: input.worktreePath,
    iterationBudget: UNIFIER_DEFAULT_ITERATION_CAP,
    demoShape,
    qualityGateCmd,
    feedbackRef,
  });

  const systemPrompt = buildUnifierSystemPrompt();
  const sdkQueryFn = sdkQuery as unknown as QueryFn;

  const agent = createClaudeAgent({
    model: UNIFIER_MODEL,
    allowedTools: [...UNIFIER_ALLOWED_TOOLS],
    disallowedTools: [...UNIFIER_DISALLOWED_TOOLS],
    permissionMode: 'acceptEdits',
    systemPrompt,
    maxTurnsPerIteration: DEV_LIVE_MAX_TURNS_PER_ITERATION,
    // Per CONTRACTS.md C19: no $ cap on the unifier. Iteration cap is the only bound.
    queryFn: sdkQueryFn,
  });

  // Composed quality gate per plan 04: ALL of:
  //   1. initiative_gate (project quality_gate_cmd against branch tip)
  //   2. demo_runs_clean (demo.command exits 0 — excused for shape "none")
  //   3. pr_self_contained (DEMO.md exists + pr-description.md ≥ 300 chars + ## Demo block)
  //   4. branches_in_sync (assertLocalRemoteSynced doesn't throw)
  const unifierGate = async (): Promise<boolean> =>
    composedUnifierGate({
      worktreePath: input.worktreePath,
      initiativeId: input.initiativeId,
      qualityGateCmd,
      demoShape,
      demoCommand: projectConfig?.demo.command,
      logger,
      initiativeIdForEvent: input.initiativeId,
      parentEventId: start.event_id,
    });

  let loopResult: LoopResult | null = null;
  let runnerError: string | null = null;
  try {
    loopResult = await runRalph(
      {
        workItemSpecPath: promptPath,
        worktreePath: input.worktreePath,
        initiativeBudget: {
          iterations: UNIFIER_DEFAULT_ITERATION_CAP,
          usd: Number.POSITIVE_INFINITY,
        },
        brainQueryResults: '',
        cycleId: logger.cycleId,
        initiativeId: input.initiativeId,
        qualityGate: unifierGate,
        onIteration: (iteration, info) => {
          logger.emit({
            initiative_id: input.initiativeId,
            parent_event_id: start.event_id,
            phase: 'developer-loop',
            skill: 'developer-unifier',
            event_type: 'iteration',
            iteration,
            input_refs: [input.worktreePath],
            output_refs: info.filesChanged,
            cost_usd: info.costUsd,
            tokens_in: info.tokensIn,
            tokens_out: info.tokensOut,
            metadata: {
              tools_used: info.toolsUsed,
              bash_commands: info.bashCommands,
              last_assistant_text: info.lastAssistantText,
            },
          });
        },
      },
      agent,
    );
  } catch (err) {
    runnerError = err instanceof Error ? err.message : String(err);
  }

  // Push once more at unifier close, then assert sync. The unifier may have
  // committed the demo bundle + closing commit; push so origin matches local.
  const push = pushInitiativeBranch(input.worktreePath);
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'developer-loop',
    skill: 'developer-unifier',
    event_type: push.pushed ? 'log' : 'error',
    input_refs: [input.worktreePath],
    output_refs: [],
    message: push.pushed ? 'unifier.branch-pushed' : 'unifier.branch-push-failed',
    metadata: push.pushed ? { branch: push.branch } : { reason: push.reason },
  });

  // Classify the unifier outcome.
  const succeeded = loopResult?.status === 'complete' && runnerError === null;
  let failureClass: string | null = null;
  if (!succeeded) {
    // Default classification — the composed gate's own events specialise
    // this further (dev-loop-unifier-{gate,demo}-failed are emitted from
    // inside composedUnifierGate when the relevant sub-gate fails).
    failureClass = 'dev-loop-unifier-gate-failed';
  }

  // Branch-divergence check (last). If branches aren't in sync, that
  // dominates the failure class — surface it specifically.
  try {
    assertLocalRemoteSynced(input.worktreePath);
  } catch {
    failureClass = 'dev-loop-unifier-branch-divergence';
  }

  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: start.event_id,
    phase: 'developer-loop',
    skill: 'developer-unifier',
    event_type: succeeded ? 'end' : 'error',
    input_refs: [input.worktreePath],
    output_refs: [input.worktreePath],
    duration_ms: loopResult?.duration_ms ?? 0,
    cost_usd: loopResult?.cost_usd ?? 0,
    message: succeeded ? 'unifier.end' : 'unifier.failed',
    metadata: {
      status: loopResult?.status ?? 'crashed',
      iterations: loopResult?.iterations ?? 0,
      stop_reason: loopResult?.stop_reason ?? 'crashed',
      demo_shape: demoShape,
      runner_error: runnerError,
      failure_class: failureClass,
    },
  });
}

type ComposedUnifierGateInput = {
  worktreePath: string;
  initiativeId: string;
  qualityGateCmd: string[];
  demoShape: import('../project-config.ts').DemoShape;
  demoCommand: string[] | undefined;
  logger: EventLogger;
  initiativeIdForEvent: string;
  parentEventId: string;
};

/**
 * The four-gate composed check the unifier must clear to exit clean:
 *   1. initiative_gate — project quality_gate_cmd against branch tip.
 *   2. demo_runs_clean — demo.command exits 0 (excused for shape "none").
 *   3. pr_self_contained — DEMO.md + pr-description.md ≥ 300 chars + `## Demo`.
 *   4. branches_in_sync — assertLocalRemoteSynced doesn't throw.
 *
 * Returns true ONLY when all four pass. Emits a classified event on each
 * sub-gate failure so the operator sees exactly which gate blocked.
 */
async function composedUnifierGate(input: ComposedUnifierGateInput): Promise<boolean> {
  const { worktreePath, initiativeId, qualityGateCmd, demoShape, demoCommand, logger } = input;

  // 1. initiative_gate
  if (!runShellGate(worktreePath, qualityGateCmd)) {
    logger.emit({
      initiative_id: input.initiativeIdForEvent,
      parent_event_id: input.parentEventId,
      phase: 'developer-loop',
      skill: 'developer-unifier',
      event_type: 'error',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'unifier.gate.initiative-failed',
      metadata: { failure_class: 'dev-loop-unifier-gate-failed', command: qualityGateCmd },
    });
    return false;
  }

  // 2. demo_runs_clean — excused for shape "none"
  if (demoShape !== 'none' && demoCommand && demoCommand.length > 0) {
    if (!runShellGate(worktreePath, demoCommand)) {
      logger.emit({
        initiative_id: input.initiativeIdForEvent,
        parent_event_id: input.parentEventId,
        phase: 'developer-loop',
        skill: 'developer-unifier',
        event_type: 'error',
        input_refs: [worktreePath],
        output_refs: [],
        message: 'unifier.gate.demo-failed',
        metadata: { failure_class: 'dev-loop-unifier-demo-failed', command: demoCommand },
      });
      return false;
    }
  }

  // 3. pr_self_contained
  const demoMdPath = join(worktreePath, 'demo', initiativeId, 'DEMO.md');
  const prDescPath = join(worktreePath, '.forge', 'pr-description.md');
  const demoMdExists = existsSync(demoMdPath);
  let prBodyOk = false;
  if (existsSync(prDescPath)) {
    let body = '';
    try {
      body = readFileSync(prDescPath, 'utf8');
    } catch {
      body = '';
    }
    prBodyOk = body.length >= 300 && /^## Demo\b/m.test(body);
  }
  if (!demoMdExists || !prBodyOk) {
    logger.emit({
      initiative_id: input.initiativeIdForEvent,
      parent_event_id: input.parentEventId,
      phase: 'developer-loop',
      skill: 'developer-unifier',
      event_type: 'error',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'unifier.gate.pr-not-self-contained',
      metadata: {
        failure_class: 'dev-loop-unifier-demo-failed',
        demo_md_exists: demoMdExists,
        pr_body_ok: prBodyOk,
      },
    });
    return false;
  }

  // 4. branches_in_sync
  try {
    assertLocalRemoteSynced(worktreePath);
  } catch (err) {
    logger.emit({
      initiative_id: input.initiativeIdForEvent,
      parent_event_id: input.parentEventId,
      phase: 'developer-loop',
      skill: 'developer-unifier',
      event_type: 'error',
      input_refs: [worktreePath],
      output_refs: [],
      message: 'unifier.gate.branches-not-in-sync',
      metadata: {
        failure_class: 'dev-loop-unifier-branch-divergence',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }

  return true;
}

function runShellGate(worktreePath: string, cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
