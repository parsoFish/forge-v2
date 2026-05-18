/**
 * Review-loop phase runner.
 *
 * Phase 6 (review-phase redesign) — the review phase is now a holistic
 * intent gate that ends at a demo-embedded PR and STOPS. It NO LONGER
 * merges (G9): the GitHub PR is the operator's merge + feedback surface.
 *
 * Flow:
 *   1. Holistic intent assessment of the WHOLE initiative branch vs the
 *      initiative intent (manifest + work items), not isolated WIs.
 *   2. If the branch is misaligned (bugs / drift / gaps) the gate MAY
 *      spawn a targeted developer-loop to refine/fix/align before review
 *      (reuses `runDeveloperLoop`; see `maybeSpawnAlignmentDevLoop`).
 *   3. Review-Ralph prepares (or refines via send-back) the demo + PR
 *      draft on the initiative branch; the orchestrator-side verdict gate
 *      runs between iterations.
 *   4. On an approved verdict (review gate passed — NOT a merge signal)
 *      the demo-embedded PR is created on the project repo and the phase
 *      returns `pr-open`. The closure step (cycle.ts → phases/closure.ts)
 *      decides `merged` vs `pr-open` strictly from a GitHub-confirmed
 *      merge. Nothing here auto-merges.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type { EventLogger } from '../logging.ts';
import {
  REVIEWER_ALLOWED_TOOLS,
  REVIEWER_DISALLOWED_TOOLS,
  REVIEWER_MODEL,
  buildReviewerSystemPrompt,
  prepareReviewerWorkspace,
  tallyToolUse as tallyReviewerToolUse,
  wipeRalphScratch,
  type ReviewerToolUseSummary,
} from '../reviewer-invocation.ts';
import {
  makeReviewerQualityGate,
  type GetVerdict,
  type ReviewerGateState,
} from '../reviewer-stage2.ts';
import { notify } from '../notify.ts';
import { readWorkItemsFromDir, type WorkItem } from '../work-item.ts';
import { createClaudeAgent, type QueryFn } from '../../loops/ralph/claude-agent.ts';
import { run as runRalph, type LoopResult } from '../../loops/ralph/runner.ts';
import { openPullRequest } from '../pr.ts';
import { resolveNotifyConfig } from '../config.ts';
import type { CycleInput, ReviewerOutcome } from '../cycle-context.ts';

/**
 * Defaults for the live reviewer Ralph loop. The agent runs as a Ralph loop
 * on the initiative branch; the orchestrator's quality-gate function calls
 * `getVerdict` between iterations. On `approve` the review GATE passes —
 * the orchestrator opens the demo-embedded PR and STOPS (Phase 6 / G9: an
 * approve verdict NEVER merges; the GitHub PR is the operator's merge
 * surface, and closure decides `merged` only from a GitHub-confirmed
 * merge). On `send-back`, the gate appends feedback to fix_plan.md and the
 * loop continues. Cap: 3 iterations (1 prep + 2 send-back rounds).
 */
const REVIEWER_LIVE_DEFAULT_ITERATIONS = 3;

// Operator decision (2026-05-18): the per-iteration $/turn budget guards on
// the reviewer were removed. They were undersized for medium initiatives —
// every iteration hit the ~$0.60 cap before producing the demo + PR
// description, so the pre-verdict gate never passed and the reviewer never
// reached the operator verdict gate (0 verdicts, mislabelled
// send-back-cap-exhausted). We have NOT observed the reviewer spinning
// endlessly, so the iteration/round cap (`iterationCap`, the send-back
// protocol bound) is the loop's terminator; an explicit per-iteration $/turn
// guard is not reinstated until evidence shows it is needed. Benches still
// pass an explicit `reviewIterationBudgetUsd` (review-loop / chained sdk),
// so bench cost accounting is unaffected.

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
 * Default verdict-provider used ONLY when CycleInput.getVerdict is omitted —
 * which in practice is the per-phase review-loop bench (it tests stage 1
 * only). It approves immediately so the loop terminates after iteration 1.
 *
 * This is SAFE in production by construction (Phase 6 / G9): an `approve`
 * verdict no longer merges anything — it only releases the review gate, and
 * `runReviewer` then opens the PR and STOPS. The merge decision is made
 * solely by `closure.ts` from a GitHub-confirmed merge (`gh pr view --json
 * state == MERGED`). It is also unreachable on the product path regardless:
 * the scheduler ALWAYS supplies a real file-based operator verdict-provider
 * (`makeFileVerdict`, scheduler.ts) and the chained bench supplies its
 * simulator — `CycleInput.getVerdict` is never actually omitted at runtime.
 * No production code path auto-supplies a verdict that causes a merge or
 * auto-advances a human moment; bench simulators stay bench-only.
 */
const defaultGetVerdict: GetVerdict = async () => ({
  kind: 'approve',
  rationale:
    'default verdict-provider — supply CycleInput.getVerdict to drive stage 2 properly. (Phase 6: approve does NOT merge; closure decides merge from a confirmed GitHub merge.)',
});

export async function runReviewer(input: CycleInput, logger: EventLogger): Promise<ReviewerOutcome> {
  const start = logger.emit({
    initiative_id: input.initiativeId,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: 'start',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
  });

  const forgeRoot = resolve(import.meta.dirname, '..', '..');
  const projectType = inferProjectType(input.worktreePath);
  const qualityGateCmd =
    input.qualityGateCmd ??
    (existsSync(resolve(input.worktreePath, 'package.json')) ? ['npm', 'test'] : ['true']);
  // F-30: adaptive reviewer iteration cap. The default of 3 (1 prep + 2
  // send-back rounds) is right for small diffs, but for large structural
  // refactors (100+ files renamed/deleted) the reviewer needs more rounds
  // just to summarise and demo. Scale by the count of changed files between
  // the merge-base and HEAD, capped to avoid runaway budgets.
  const adaptiveCap = computeAdaptiveReviewIterationCap(input.worktreePath);
  const iterationCap = input.reviewIterationCap ?? adaptiveCap;
  // No production $ budget guard (operator decision above): when the bench
  // supplies an explicit per-iteration budget we honour it; otherwise the
  // reviewer Ralph loop is bounded only by `iterationCap` (rounds), not cost.
  const usdBudget =
    input.reviewIterationBudgetUsd ?? Number.POSITIVE_INFINITY;

  // Read the completed work items the reviewer will be reviewing.
  const workItemsDir = resolve(input.worktreePath, '.forge', 'work-items');
  const { items: workItems } = readWorkItemsFromDir(workItemsDir);

  // US-1.3: holistic intent assessment. BEFORE the review-Ralph, assess
  // the WHOLE initiative branch against the initiative intent (manifest +
  // every WI's acceptance criteria) — not isolated WIs. The orchestrator-
  // verified signal is the project quality gate run against the whole
  // merged branch (truth, never the agent's claim). If the branch is
  // misaligned the gate MAY spawn a targeted developer-loop to refine /
  // fix / align before review (reuses runDeveloperLoop — no new engine).
  await assessIntentHolisticallyAndMaybeRefine(input, logger, {
    parentEventId: start.event_id,
    workItems,
    qualityGateCmd,
  });

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
    // No per-iteration turn/$ cap on the reviewer agent (operator decision
    // above). Omitted ⇒ createClaudeAgent leaves the SDK options unset ⇒
    // unbounded per iteration; the loop's bound is `iterationCap` (rounds).
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
        // F-23: include rich tool-use + agent-text observability fields.
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

  // F-41c: brain-first runtime gate REMOVED from the review-loop. Same
  // reasoning as F-34 for dev: the reviewer's job is verify + write-PR
  // anchored on the git log / diff / spec already in the worktree. Brain
  // themes about PR conventions (squash-merge-stacked-prs, etc.) are
  // forge-system patterns the orchestrator already enforces — the agent
  // doesn't need to read them every iteration. Diagnosed in the 22:17
  // cycle: reviewer re-read the same 4 brain themes in all 6 iterations,
  // burning $0.10-0.20 per iter before doing real PR work, then panicked
  // about budget. brainReads tally remains for telemetry; just not gated.

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
    // G9: the review gate passed. Create the demo-embedded PR on the
    // project repo and STOP. The reviewer NEVER merges — the GitHub PR is
    // the operator's merge + feedback surface. The closure step decides
    // `merged` vs `pr-open` strictly from a GitHub-confirmed merge.
    const prDescriptionPath = resolve(input.worktreePath, '.forge', 'pr-description.md');
    // Prefer a human-readable PR title pulled from the PR description's
    // first heading. Falls back to the initiative ID when the description
    // is absent or malformed (machine-readable but at least scoped to the
    // initiative — better than the worktree's basename).
    const prTitle = extractPrTitle(prDescriptionPath, input.initiativeId);
    prUrl = openPullRequest(input.worktreePath, prDescriptionPath, prTitle);
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: prUrl ? 'log' : 'error',
      input_refs: [prDescriptionPath],
      output_refs: prUrl ? [prUrl] : [],
      message: prUrl ? 'reviewer.pr-opened' : 'reviewer.pr-open-failed',
      metadata: { url: prUrl, pr_created: prUrl !== null },
    });

    // The reviewer does NOT move the manifest — it stays in `in-flight/`
    // through review (it IS in flight). The CLOSURE step is the single
    // terminal-move authority: `in-flight → done` on a confirmed merge
    // (G1), `in-flight → ready-for-review` otherwise. Keeping one mover
    // matches queue.ts:moveTo's `from = in-flight` contract and avoids the
    // double-move defect. If `gh pr create` succeeded → `pr-open`; if it
    // failed → `ready-for-review` (operator opens it manually / re-runs).
    outcome = prUrl ? 'pr-open' : 'ready-for-review';

    try {
      await notify(
        {
          type: 'review-ready',
          title: input.initiativeId,
          body: prUrl
            ? `Review gate passed — PR open, awaiting your merge: ${prUrl}`
            : 'Review gate passed but PR creation failed — open it manually',
          url: prUrl ?? undefined,
          metadata: { initiative_id: input.initiativeId, outcome },
        },
        resolveNotifyConfig(),
      );
    } catch {
      /* best-effort */
    }
  } else if (loopResult.stop_reason === 'iteration-budget') {
    // F-11: send-back cap exhausted is NOT a phantom value any more. Move the
    // manifest to `ready-for-review/` so the operator can pick up via
    // `forge review` (PR draft exists; the agent ran out of send-back rounds
    // before reaching an approved verdict). Return outcome cleanly — the
    // dispatch helper notifies as 'failed' to surface the cap exhaustion.
    outcome = 'send-back-cap-exhausted';
    // F-29: fall-through PR description. The reviewer-Ralph may have run out
    // of iterations before writing pr-description.md (or written a stub);
    // either way, the human picking this up via `forge review <id>` should
    // see a usable description even if the agent didn't produce one. Write
    // a deterministic version from git log + diff stat — no LLM call, no
    // chance of fabrication. If the file already exists with real content,
    // leave it alone.
    try {
      ensureMinimalPrDescription(input.worktreePath, input.initiativeId);
    } catch {
      /* best-effort — never break the cycle for a description fallback */
    }
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: start.event_id,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'reviewer.send-back-cap-exhausted',
      metadata: {
        rounds: gateState.invocations,
        verdicts: gateState.verdicts.length,
        // verdicts === 0 ⇒ the loop exhausted iterations WITHOUT ever
        // reaching the operator verdict gate (a reviewer-side stall, not a
        // human send-back). Distinct from rounds>0 (genuine send-back cap).
        never_reached_verdict: gateState.verdicts.length === 0,
      },
    });
    // Manifest stays in-flight; closure moves it to ready-for-review/.
  } else {
    // Loop ended without approval AND not via iteration budget — wedged or
    // another stop condition. Treat as ready-for-review (PR draft exists but
    // not approved); operator can pick up manually. Manifest stays
    // in-flight; closure performs the single terminal move.
    outcome = 'ready-for-review';
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
 * Run the project quality gate against the WHOLE initiative branch (truth,
 * never the agent's claim). The same command the dev-loop and review-Ralph
 * use; here it is the holistic, branch-level alignment signal.
 */
function runHolisticGate(worktreePath: string, cmd: string[]): boolean {
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
 * US-1.3 — holistic intent gate (+ optional spawned alignment dev-loop).
 *
 * Assesses the WHOLE initiative branch against the initiative intent
 * (manifest + every WI's acceptance criteria), not isolated WIs. The
 * orchestrator-verified alignment signal is the project quality gate run
 * against the whole branch. When the branch is misaligned, the gate MAY
 * spawn a targeted developer-loop to refine / fix / align before the
 * review-Ralph produces the PR — reusing `runDeveloperLoop` (no new
 * engine, per the redesign + brain theme `review-phase-target-design`).
 *
 * MINIMAL by design: the structural hook + the orchestrator-verified gate
 * are fully wired. The LLM-driven synthesis of *which* targeted WIs to
 * regenerate from a holistic misalignment is the remaining seam — see
 * `maybeSpawnAlignmentDevLoop`. G8/G9/G10/G1 do not depend on that seam.
 */
async function assessIntentHolisticallyAndMaybeRefine(
  input: CycleInput,
  logger: EventLogger,
  ctx: { parentEventId: string; workItems: WorkItem[]; qualityGateCmd: string[] },
): Promise<void> {
  const aligned = runHolisticGate(input.worktreePath, ctx.qualityGateCmd);
  const totalAcs = ctx.workItems.reduce((n, wi) => n + wi.acceptance_criteria.length, 0);
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: ctx.parentEventId,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: aligned ? 'log' : 'error',
    input_refs: [input.worktreePath, input.manifestPath],
    output_refs: [],
    message: aligned
      ? 'reviewer.holistic-intent-aligned'
      : 'reviewer.holistic-intent-misaligned',
    metadata: {
      gate_command: ctx.qualityGateCmd.join(' '),
      gate_passed: aligned,
      work_item_count: ctx.workItems.length,
      acceptance_criteria_count: totalAcs,
      assessed: 'whole-branch-vs-intent',
    },
  });
  if (!aligned) {
    await maybeSpawnAlignmentDevLoop(input, logger, {
      parentEventId: ctx.parentEventId,
      reason: 'holistic quality gate failed against the whole branch',
    });
  }
}

/**
 * Structural hook: spawn a targeted developer-loop to align the branch to
 * intent, reusing the existing `runDeveloperLoop` runner (no new engine).
 *
 * Opt-in via `CycleInput.spawnAlignmentDevLoop` (default OFF): the
 * unattended path keeps the review-Ralph's send-back loop as the primary
 * gap-filler. When enabled, this re-runs the dev-loop over the existing
 * WI set so any WI whose acceptance criteria regressed is re-driven to
 * green before the PR is produced.
 *
 * SEAM (intentionally left, per the Phase-6 spec's MINIMAL allowance):
 * a richer implementation would have the reviewer LLM synthesise *new*
 * targeted WIs describing the specific holistic misalignment (cross-WI
 * integration bugs the per-WI ACs cannot express) and the dev-loop would
 * run those. That LLM-driven WI synthesis is deferred — it needs a
 * live-cycle bench to tune (API cost) and G8/G9/G10/G1 do not depend on
 * it. The hook below is the real structural integration point so wiring
 * the synthesis later is a localized change, not a re-architecture.
 */
async function maybeSpawnAlignmentDevLoop(
  input: CycleInput,
  logger: EventLogger,
  ctx: { parentEventId: string; reason: string },
): Promise<void> {
  if (!input.spawnAlignmentDevLoop) {
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: ctx.parentEventId,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'log',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'reviewer.alignment-dev-loop-skipped',
      metadata: {
        reason: ctx.reason,
        note: 'spawnAlignmentDevLoop disabled — review-Ralph send-back loop is the gap-filler',
      },
    });
    return;
  }
  // Lazy import to avoid a static reviewer→developer-loop module cycle
  // (cycle.ts wires both; the phases must not hard-depend on each other).
  const { runDeveloperLoop } = await import('./developer-loop.ts');
  logger.emit({
    initiative_id: input.initiativeId,
    parent_event_id: ctx.parentEventId,
    phase: 'review-loop',
    skill: 'reviewer',
    event_type: 'log',
    input_refs: [input.worktreePath],
    output_refs: [],
    message: 'reviewer.alignment-dev-loop-spawned',
    metadata: { reason: ctx.reason },
  });
  try {
    await runDeveloperLoop(input, logger);
  } catch (err) {
    // A failed alignment dev-loop is NOT fatal to the review phase — the
    // review-Ralph + send-back loop is still the convergence path, and
    // the operator sees the result on the PR. Log and continue.
    logger.emit({
      initiative_id: input.initiativeId,
      parent_event_id: ctx.parentEventId,
      phase: 'review-loop',
      skill: 'reviewer',
      event_type: 'error',
      input_refs: [input.worktreePath],
      output_refs: [],
      message: 'reviewer.alignment-dev-loop-failed',
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * F-30: scale the reviewer iteration cap to the size of the diff. The
 * baseline (3 rounds = 1 prep + 2 send-back) is fine for typical 5-20 file
 * diffs; larger refactors need proportionally more rounds for the reviewer
 * to read, summarise, gate, demo, and write the PR description. Without
 * scaling, a 107-file diff (e.g., trafficGame's test-suite quarantine)
 * exhausts the cap before the reviewer can produce anything usable.
 *
 * Mapping (changed-file count → iteration cap):
 *   ≤   20 files  →  3   (default)
 *   ≤   50 files  →  4
 *   ≤  100 files  →  5
 *   ≤  200 files  →  6
 *   >  200 files  →  8   (hard cap; no runaway budgets)
 *
 * Errors during diff inspection (no merge-base, git failure, etc.) fall back
 * to the baseline 3 — same as today.
 */
export function computeAdaptiveReviewIterationCap(worktreePath: string): number {
  let changed = 0;
  try {
    // `--name-only` between merge-base and HEAD; line count = changed-file count.
    const out = execFileSync(
      'git',
      ['-C', worktreePath, 'diff', '--name-only', 'main...HEAD'],
      { stdio: 'pipe' },
    ).toString('utf8');
    changed = out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return REVIEWER_LIVE_DEFAULT_ITERATIONS;
  }
  if (changed <= 20) return 3;
  if (changed <= 50) return 4;
  if (changed <= 100) return 5;
  if (changed <= 200) return 6;
  return 8;
}

/**
 * F-29: ensure `<worktree>/.forge/pr-description.md` exists with a usable
 * draft, generated deterministically from git log + diff stat. Called when
 * the reviewer-Ralph runs out of iterations and the human is about to pick
 * up the cycle via `forge review <id>` — without this, they may inherit an
 * empty / fabricated description.
 *
 * Idempotent: leaves an existing description untouched if it has real content
 * (≥ 300 chars, the same threshold the reviewer mandate uses). Only stamps a
 * fallback when the existing description is missing or too thin to be useful.
 *
 * No LLM call; no risk of hallucinated content. Worst-case the human edits it.
 */
function ensureMinimalPrDescription(worktreePath: string, initiativeId: string): void {
  const prPath = resolve(worktreePath, '.forge', 'pr-description.md');
  if (existsSync(prPath)) {
    const existing = readFileSync(prPath, 'utf8');
    if (existing.length >= 300) return;
  }
  // Pull a deterministic summary from git: last 20 commits + diff stat.
  let commits = '';
  let diffStat = '';
  try {
    commits = execFileSync(
      'git',
      ['-C', worktreePath, 'log', '--no-color', '--format=- %s', '-n', '20'],
      { stdio: 'pipe' },
    ).toString('utf8').trim();
  } catch {
    commits = '_(no commits captured)_';
  }
  try {
    diffStat = execFileSync(
      'git',
      ['-C', worktreePath, 'diff', '--stat', 'HEAD~1', 'HEAD'],
      { stdio: 'pipe' },
    ).toString('utf8').trim();
  } catch {
    diffStat = '_(no diff stat available)_';
  }
  if (!existsSync(resolve(worktreePath, '.forge'))) {
    mkdirSync(resolve(worktreePath, '.forge'), { recursive: true });
  }
  const body = [
    `# ${initiativeId} (auto-drafted)`,
    '',
    '> ⚠️ **Reviewer-Ralph ran out of iterations before producing a hand-crafted PR description.** This draft was generated deterministically from `git log` + `git diff --stat`. Please review and edit before merging.',
    '',
    '## Why',
    '',
    `Initiative ${initiativeId} reached the review phase but the agent could not converge within the iteration cap. The work below was committed during the dev-loop; verify each commit lands what its message claims, and either approve via \`forge review ${initiativeId} --approve\` or send back via the verdict prompt at \`_queue/ready-for-review/${initiativeId}.md.verdict-prompt\`.`,
    '',
    '## What',
    '',
    'Recent commits on this branch:',
    '',
    commits,
    '',
    '## How',
    '',
    'Diff stat (HEAD~1..HEAD):',
    '',
    '```',
    diffStat,
    '```',
    '',
    '## Demo',
    '',
    '_(automated demo not produced — reviewer-Ralph exhausted iterations before generating one. Run the project locally and verify the changes manually before merging, or send-back to request a re-attempt.)_',
    '',
  ].join('\n');
  writeFileSync(prPath, body);
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
