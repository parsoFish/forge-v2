/**
 * Shared reviewer invocation contract — system prompt + user prompt builders +
 * tool config.
 *
 * Both the bench harness (benchmarks/review-loop/sdk.ts) and the live
 * orchestrator (orchestrator/cycle.ts:runReviewer) call into this module.
 * Single source of truth for what the reviewer agent sees, so the bench
 * reflects production exactly.
 *
 * Stage 1 (review-prep) only — the agent verifies the post-developer-loop
 * branch is functional, records a video demo, and drafts a PR description.
 * The orchestrator does the side-effecting work after this skill exits
 * (`gh pr create`, queue movement, notification). Stage 2 (interactive human
 * review + send-back loop) is implemented separately.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadBrainIndex } from './brain-index.ts';
import type { WorkItem } from './work-item.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const SKILL_PATH = resolve(FORGE_ROOT, 'skills', 'reviewer', 'SKILL.md');

export type ReviewerAllowedTool = 'Read' | 'Grep' | 'Glob' | 'Write' | 'Edit' | 'Bash';
export type ReviewerDisallowedTool = 'NotebookEdit' | 'WebFetch' | 'WebSearch';

export const REVIEWER_ALLOWED_TOOLS: ReviewerAllowedTool[] = [
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'Bash',
];
export const REVIEWER_DISALLOWED_TOOLS: ReviewerDisallowedTool[] = [
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];
export const REVIEWER_MODEL = 'claude-sonnet-4-6';

let cachedSkillText: string | null = null;
function loadSkillText(): string {
  if (cachedSkillText !== null) return cachedSkillText;
  cachedSkillText = readFileSync(SKILL_PATH, 'utf8');
  return cachedSkillText;
}

let cachedBrainIndex: string | null = null;
function loadBrainNavigation(cwd: string): string {
  if (cachedBrainIndex !== null) return cachedBrainIndex;
  cachedBrainIndex = loadBrainIndex({ cwd });
  return cachedBrainIndex;
}

/**
 * Build the reviewer system prompt: brain navigation index + the SKILL.md
 * contract + reviewer-specific discipline notes (demo tool selection,
 * gate-then-PR ordering).
 *
 * @param brainCwd - directory containing `brain/`. For the bench this is the
 *   tempdir (with symlinked brain/); for the live cycle this is the forge root.
 */
export function buildReviewerSystemPrompt(brainCwd: string): string {
  return [
    '# Brain navigation index',
    '',
    "Below are the brain's category indexes — every theme in scope, with a one-line description. Use these descriptions to identify candidate theme pages, then read those files in full to verify and extract precise terminology, project names, and patterns. The indexes ARE the retrieval index; you should rarely need grep.",
    '',
    loadBrainNavigation(brainCwd),
    '',
    '---',
    '',
    '# reviewer skill contract',
    '',
    loadSkillText(),
    '',
    '---',
    '',
    '# Review-loop Ralph discipline',
    '',
    'You are inside a **Ralph loop** running on the initiative branch. Each call to you is **one iteration**. The loop carries state via three worktree files you must read at the start of every iteration:',
    '',
    '- **`PROMPT.md`** — the per-iteration brief (initiative ID, manifest path, demo tool, iteration counter).',
    '- **`AGENT.md`** — institutional memory across iterations and prior verdicts (each round\'s verdict appended). Read first, update last.',
    '- **`fix_plan.md`** — checklist of work for *this* iteration. **Iteration 1**: empty (your job is to prepare the demo + PR draft from scratch). **Iterations 2+**: contains a `## Round N send-back` section the previous reviewer-verdict appended — you must address every unchecked item under that header.',
    '',
    '**Iteration N body:**',
    '1. Read `PROMPT.md`, `AGENT.md`, `fix_plan.md`.',
    '2. **If fix_plan.md has unchecked send-back items**: edit the code to satisfy them. Run quality gates. Re-record the demo (the source script may need new lines exercising the new ACs). Re-draft `pr-description.md` to reflect the new state. Tick the items.',
    '3. **If fix_plan.md is empty (iteration 1)**: prepare the initial demo bundle + `pr-description.md`. Run quality gates first; do NOT write `pr-description.md` if gates fail.',
    '4. Commit changes with conventional-commits messages.',
    '5. Update `AGENT.md` with what you tried this iteration.',
    '',
    'Outputs (every iteration):',
    '- Demo bundle at `<worktree>/.forge/demos/<initiative-id>/` (source script + recording + README.md)',
    '- PR draft at `<worktree>/.forge/pr-description.md` (Why / What / How / Demo sections; body ≥ 300 chars; Why ≥ 50 chars)',
    '',
    '**The orchestrator decides when to stop, not you.** Between your iterations the orchestrator:',
    '1. Re-runs the project quality gate (orchestrator-verified — never trusts your claim).',
    '2. Asks the reviewer (human in production; simulator agent in bench) for a verdict: `approve` | `send-back: <feedback>`.',
    '3. On `approve` → loop ends, orchestrator merges + moves manifest to `_queue/done/`.',
    '4. On `send-back` → feedback is appended to `fix_plan.md` as new unchecked ACs; you start the next iteration.',
    '',
    'Hard rules:',
    '- **Quality gates first.** Run the project quality gate command before drafting/refreshing `pr-description.md`. If gates fail, fix them in this iteration; do NOT write `pr-description.md` until they pass.',
    '- **Demo tool selection.** Browser/canvas/DOM rendering → Playwright (write `source.spec.ts`, run `npx playwright test --trace=on`). Everything else → VHS (write `source.tape`, run `vhs source.tape -o recording.mp4`). VHS is the default; Playwright is the exception.',
    '- **Demo source must reference each WI\'s acceptance-criterion `then`-clause keywords textually**, plus any send-back ACs from `fix_plan.md`.',
    '- **PR description sections (in this order, all required):** `## Why` (≥ 50 chars), `## What`, `## How`, `## Demo`. Total body ≥ 300 chars.',
    '- **Squash-merge stacked PRs is forbidden** (brain theme `squash-merge-stacked-prs`). Include a `Parents:` block if stacked.',
    '- **Brain-first (REQUIRED, mandatory).** Your first tool calls in iteration 1 MUST be `Read`/`Grep`/`Glob` against `brain/...` paths (PR/demo conventions, project taste signals, past review gotchas). The orchestrator records `tool_use.brainReads` and **fails the review phase if zero brain reads are recorded**. This is unconditional — not "when unsure".',
    '- **No `gh pr create`, no `gh pr merge`.** The orchestrator owns those. You write the artifacts; the orchestrator opens and merges the PR after the verdict.',
    '- **No queue mutation.** `_queue/` is read-only for you. The orchestrator moves the manifest after approval.',
    '- **No web tools.** `WebFetch` and `WebSearch` are disabled.',
  ].join('\n');
}

export type ReviewerUserPromptInput = {
  initiativeId: string;
  /** Path to the initiative manifest, relative to the cwd the SDK runs in. */
  manifestRelPath: string;
  /** Path to the worktree, relative to the cwd the SDK runs in. */
  worktreeRelPath: string;
  projectName: string;
  /** Project type — informs the agent's demo-tool decision. */
  projectType: 'browser' | 'cli' | 'lib' | 'rest';
  /** Quality gate command to run (must pass before pr-description.md is written). */
  qualityGateCmd: string;
  /**
   * Whether this PR is part of a stacked sequence. When true, the agent must
   * include a `Parents:` block in the PR description so the orchestrator
   * knows to merge (not squash).
   */
  isStackedPr: boolean;
};

/**
 * Render the per-iteration prompt body the agent reads at the start of each
 * Ralph iteration (stamped into PROMPT.md on iteration 1; the runner re-reads
 * it each iteration). Iteration 1 = prep work; iterations 2+ react to fix_plan.md.
 */
export function renderReviewerUserPrompt(input: ReviewerUserPromptInput): string {
  const demoTool = input.projectType === 'browser' ? 'Playwright' : 'VHS';
  const sourceFile = input.projectType === 'browser' ? 'source.spec.ts' : 'source.tape';
  const recordingFile =
    input.projectType === 'browser' ? 'recording.trace.zip' : 'recording.mp4';
  const recordCmd =
    input.projectType === 'browser'
      ? 'npx playwright test source.spec.ts --reporter=list --trace=on'
      : 'vhs source.tape -o recording.mp4';

  return [
    '# Review-loop iteration brief',
    '',
    `> Initiative: **${input.initiativeId}** · Project: **${input.projectName}** (\`${input.projectType}\`) · Demo tool: **${demoTool}**`,
    '',
    '## Inputs',
    '',
    `- Initiative manifest: \`${input.manifestRelPath}\` (read this first, after the brain queries).`,
    `- Worktree: \`${input.worktreeRelPath}/\` — every WI in \`.forge/work-items/\` should be at \`status: complete\`.`,
    `- Quality gate command: \`${input.qualityGateCmd}\` (run from the worktree).`,
    '- `fix_plan.md` — your iteration backlog. **Iteration 1**: empty (no send-back yet). **Iterations 2+**: contains a `## Round N send-back` section with unchecked ACs you must address.',
    '- `AGENT.md` — institutional memory + prior round verdicts.',
    '',
    '## What to do this iteration',
    '',
    '0. **Brain queries (REQUIRED, before any other tool call on iteration 1).** `Read` at least one `brain/forge/themes/*.md` (always-relevant: `squash-merge-stacked-prs`, `layered-merge-order`, `markdown-artifact-flow`) AND at least one `brain/projects/<project>/themes/*.md` (or `profile.md`) for project taste. The orchestrator gates on this — zero `brain/...` reads = phase failure. Unconditional, not "when unsure".',
    '1. **Read AGENT.md and fix_plan.md.** This tells you whether you\'re prepping (iter 1) or refining (iter 2+).',
    '2. (Brain query already done in step 0; record the cited theme paths in AGENT.md.)',
    '3. **If fix_plan.md has unchecked send-back items** (iteration 2+): edit the project code to satisfy each item. Tests for the new ACs go alongside existing ones. After fixing, tick the items in fix_plan.md.',
    `4. **Run the quality gate**: \`${input.qualityGateCmd}\`. If it fails, fix the project code until green. Do NOT skip this — the orchestrator re-runs it between iterations and won\'t ask for a verdict if it\'s red.`,
    '5. **Record / re-record the demo.**',
    `   - Source: \`${input.worktreeRelPath}/.forge/demos/${input.initiativeId}/${sourceFile}\`.`,
    `   - The source MUST textually reference each WI\'s acceptance-criterion \`then\`-clause keywords AND any send-back ACs from fix_plan.md (commands, expected output, or assertion text).`,
    `   - Run \`${recordCmd}\` from the demo directory to produce \`${recordingFile}\` (≥ 50 KB).`,
    `   - Write/refresh the demo \`README.md\` (one paragraph: what the demo shows, prereqs, expected outcome).`,
    `6. **Draft / refresh \`${input.worktreeRelPath}/.forge/pr-description.md\`.** All four sections required: \`## Why\` (≥ 50 chars), \`## What\`, \`## How\`, \`## Demo\` (markdown link to the recording). Total body ≥ 300 chars.`,
    input.isStackedPr
      ? '   - **Stacked PR**: include a `Parents:` block in the body listing parent PR/branch names.'
      : '',
    '7. **Commit** any code/demo/PR-description changes with conventional-commits messages.',
    '8. **Update AGENT.md** with what you tried this iteration (one paragraph max).',
    '',
    '## Constraints',
    '',
    '- Do **not** call `gh pr create` or `gh pr merge`. The orchestrator owns those.',
    '- Do **not** move queue files in `_queue/`. Read-only for you.',
    '- Do **not** modify WI specs in `.forge/work-items/` (those are the developer-loop\'s contract; review feedback lives in fix_plan.md instead).',
    '- After completing this iteration, **stop**. The orchestrator runs the gate, asks for a verdict, and either stops the loop or schedules iteration N+1 with new fix_plan.md content.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------- Ralph workspace setup ----------

export type PrepareReviewerWorkspaceInput = {
  initiativeId: string;
  /** Worktree-relative manifest path used in the iteration prompt header. */
  manifestRelPath: string;
  /** Worktree-relative worktree path (usually '.'). */
  worktreeRelPath: string;
  /** Absolute path to the worktree the agent runs in. */
  worktreePath: string;
  projectName: string;
  projectType: 'browser' | 'cli' | 'lib' | 'rest';
  qualityGateCmd: string;
  isStackedPr: boolean;
  /** Already-completed work items the reviewer is reviewing. */
  workItems: WorkItem[];
  /** Brain-query results to seed AGENT.md with. v1 leaves this empty. */
  brainQueryResults?: string;
};

export type PreparedReviewerWorkspace = {
  promptPath: string;
  agentMdPath: string;
  fixPlanPath: string;
};

/**
 * F-15: wipe the dev-loop's leftover Ralph scratch files (PROMPT.md /
 * AGENT.md / fix_plan.md) from the worktree before the reviewer-Ralph stamps
 * its own. Without this, `prepareReviewerWorkspace`'s idempotency would leave
 * the reviewer agent reading stale dev-loop content and hallucinating its
 * role. Idempotent — files that are already absent are skipped.
 *
 * Exported so the cycle can call it AND so a regression test can verify the
 * behaviour directly.
 */
export function wipeRalphScratch(worktreePath: string): void {
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
 * Stamp PROMPT.md, AGENT.md, and fix_plan.md into the worktree from the
 * reviewer iteration template. Idempotent — does not overwrite already-stamped
 * files. Mirrors `prepareDevWorkspace()` in dev-invocation.ts.
 *
 * fix_plan.md starts empty (no send-back yet); the orchestrator's
 * verdict-gate appends `## Round N send-back` sections between iterations.
 */
export function prepareReviewerWorkspace(
  input: PrepareReviewerWorkspaceInput,
): PreparedReviewerWorkspace {
  const promptPath = join(input.worktreePath, 'PROMPT.md');
  const agentMdPath = join(input.worktreePath, 'AGENT.md');
  const fixPlanPath = join(input.worktreePath, 'fix_plan.md');

  if (!existsSync(promptPath)) {
    const prompt = renderReviewerUserPrompt({
      initiativeId: input.initiativeId,
      manifestRelPath: input.manifestRelPath,
      worktreeRelPath: input.worktreeRelPath,
      projectName: input.projectName,
      projectType: input.projectType,
      qualityGateCmd: input.qualityGateCmd,
      isStackedPr: input.isStackedPr,
    });
    writeFileSync(promptPath, prompt);
  }

  if (!existsSync(agentMdPath)) {
    const brainBlock =
      (input.brainQueryResults ?? '').trim() ||
      '_(no brain context seeded — read theme files yourself if needed; the system prompt has the navigation index.)_';
    const wiSummary = input.workItems
      .map(
        (wi) =>
          `- **${wi.work_item_id}** (${wi.status}): ${wi.acceptance_criteria.length} acceptance criteria; files in scope: ${wi.files_in_scope.map((f) => `\`${f}\``).join(', ')}`,
      )
      .join('\n');
    writeFileSync(
      agentMdPath,
      [
        `# Review-Loop Agent Memory — ${input.initiativeId}`,
        '',
        '> Institutional memory across review-Ralph iterations. Read at the start of every iteration; updated at the end. Verdict outcomes are appended automatically by the orchestrator after each round.',
        '',
        '## Brain context (loaded at iteration 1)',
        '',
        brainBlock,
        '',
        '## Work items being reviewed',
        '',
        wiSummary || '_(no work items found — investigate)_',
        '',
        '## What I tried',
        '',
        '_(updated by each iteration — most recent at the top)_',
        '',
        '## Verdicts',
        '',
        '_(appended by the orchestrator after each round)_',
        '',
      ].join('\n'),
    );
  }

  if (!existsSync(fixPlanPath)) {
    writeFileSync(
      fixPlanPath,
      [
        '# Fix Plan — review-loop iterations',
        '',
        '> Iteration 1: empty (your job is to prepare the demo + PR draft from scratch).',
        '> Iterations 2+: the orchestrator appends `## Round N send-back` sections here after a send-back verdict; address every unchecked AC under those headers.',
        '',
      ].join('\n'),
    );
  }

  return { promptPath, agentMdPath, fixPlanPath };
}

/** Tool-use telemetry surfaced by both the bench and the live cycle. */
export type ReviewerToolUseSummary = {
  brainReads: number;
  writes: number;
  bashCalls: number;
  recorderInvocations: number;
};

const RECORDER_HEADS = new Set(['vhs', 'npx', 'playwright']);

/**
 * Inspect a streamed assistant message and increment the summary in place.
 * `recorderInvocations` is a heuristic counted from Bash calls whose first
 * token suggests a recording tool (vhs, npx playwright); informational only.
 */
export function tallyToolUse(
  message: { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined,
  summary: ReviewerToolUseSummary,
): void {
  const blocks = message?.content ?? [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;
    const name = block.name ?? '';
    if (name === 'Write' || name === 'Edit') {
      summary.writes += 1;
    } else if (name === 'Bash') {
      summary.bashCalls += 1;
      if (looksLikeRecorder(block.input)) summary.recorderInvocations += 1;
    } else if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      const blob = JSON.stringify(block.input ?? {});
      if (blob.includes('brain/') || blob.includes('"brain"')) summary.brainReads += 1;
    }
  }
}

function looksLikeRecorder(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd !== 'string') return false;
  const head = cmd.trim().split(/\s+/)[0] ?? '';
  if (head === 'vhs') return true;
  if (head === 'npx' && cmd.includes('playwright')) return true;
  return RECORDER_HEADS.has(head) && cmd.includes('record');
}
