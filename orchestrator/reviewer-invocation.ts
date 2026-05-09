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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadBrainIndex } from './brain-index.ts';

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
    '# Reviewer discipline (stage 1 only)',
    '',
    'You are running non-interactively in stage 1 (review-prep). Your job has exactly two outputs:',
    '',
    '1. A demo bundle at `<worktree>/.forge/demos/<initiative-id>/` (source script + recording + README).',
    '2. A PR description draft at `<worktree>/.forge/pr-description.md`.',
    '',
    'You do **not** call `gh pr create`, you do **not** move queue files, you do **not** fire notifications. Those are orchestrator-side actions that run after you exit.',
    '',
    'Hard rules (enforced by the bench):',
    '- **Quality gates first.** Run the project quality gate command before drafting `pr-description.md`. If gates fail, do NOT write `pr-description.md`. Update `AGENT.md` with the failure state and exit. The bench fails any run that ships a PR draft against red gates.',
    '- **Demo tool selection.** Browser/canvas/DOM rendering → Playwright (write `source.spec.ts`, run `npx playwright test --trace=on` to produce `recording.trace.zip`). Everything else (Python lib, bash, REST via curl, terminal apps) → VHS (write `source.tape`, run `vhs source.tape -o recording.mp4`). VHS is the default; Playwright is the exception.',
    '- **Demo source must reference each WI\'s acceptance-criterion `then`-clause keywords textually.** A 5-second video of a black canvas fails the rubric. The bench greps the source file for AC keywords; make those keywords appear as commands, expected output, or assertion text.',
    '- **PR description sections (in this order, all required):** `## Why` (≥ 50 chars, the load-bearing section), `## What`, `## How`, `## Demo`. Total body length ≥ 300 chars. Three-line PR descriptions are rejected.',
    '- **Squash-merge stacked PRs is forbidden** ([brain theme](brain/forge/themes/squash-merge-stacked-prs.md)). If your PR has parent PRs, include a `Parents:` block in the body — the orchestrator will use `--merge`, not `--squash`.',
    '- **Brain-first.** Query the brain before researching elsewhere. The brain has documentation on demo recording tools, PR descriptions, merge strategy, and project-specific conventions.',
    '- **No web tools.** `WebFetch` and `WebSearch` are disabled. If you need information, the brain has it.',
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
 * Render the per-cycle / per-fixture user prompt the SDK sends to the agent.
 * Tells the agent the cwd-relative paths, the quality gate command, and
 * reiterates the stage-1 contract.
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
    '# Reviewer invocation — stage 1 (review-prep)',
    '',
    `## Initiative: ${input.initiativeId}`,
    `## Project: ${input.projectName} (\`${input.projectType}\`)`,
    '',
    '## Inputs',
    '',
    `- Initiative manifest: \`${input.manifestRelPath}\` (read this first, after the brain queries).`,
    `- Worktree: \`${input.worktreeRelPath}/\` — every work item should be at \`status: complete\`. Read \`${input.worktreeRelPath}/.forge/work-items/WI-*.md\` for acceptance criteria; the demo source must reference each WI's \`then\`-clause keywords.`,
    `- Quality gate command: \`${input.qualityGateCmd}\` (run from the worktree).`,
    '',
    '## Step-by-step',
    '',
    '1. **Brain query first.** Always-relevant themes: `squash-merge-stacked-prs`, `layered-merge-order`, `markdown-artifact-flow`. Then read the project-specific reviewer themes under `brain/projects/<project>/`.',
    `2. Confirm every WI in \`${input.worktreeRelPath}/.forge/work-items/\` is at \`status: complete\`. If any is not, stop and report — do not proceed.`,
    `3. Run the quality gate: \`${input.qualityGateCmd}\`. Capture the exit code.`,
    '4. **If gates fail:** update `AGENT.md` with the failure, do NOT write `pr-description.md`, do NOT record a demo, exit. The bench will score this run as gates-red.',
    '5. **If gates pass:**',
    `   a. Decide the demo tool. This project is \`${input.projectType}\` → use **${demoTool}**.`,
    `   b. Write \`${input.worktreeRelPath}/.forge/demos/${input.initiativeId}/${sourceFile}\`. Reference each WI's acceptance-criterion \`then\`-clause keywords textually (as commands, expected output, or assertions).`,
    `   c. Run the recorder: \`cd ${input.worktreeRelPath}/.forge/demos/${input.initiativeId} && ${recordCmd}\` to produce \`${recordingFile}\`.`,
    `   d. Write \`${input.worktreeRelPath}/.forge/demos/${input.initiativeId}/README.md\` (one paragraph: what the demo shows, prereqs to re-record, expected outcome).`,
    `   e. Compose \`${input.worktreeRelPath}/.forge/pr-description.md\` with all four required sections (\`## Why\`, \`## What\`, \`## How\`, \`## Demo\`). Why ≥ 50 chars; total body ≥ 300 chars. The Demo section must include a markdown link to the recording file.`,
    input.isStackedPr
      ? '   f. **This is a stacked PR.** Include a `Parents:` block in the PR body listing parent PR/branch names. The orchestrator will merge with `--merge`, not `--squash`.'
      : '',
    '',
    '## Constraints',
    '',
    '- Do **not** call `gh pr create`. The orchestrator does that after you exit.',
    '- Do **not** move queue files in `_queue/`. Read-only for you.',
    '- Do **not** fire notifications. Orchestrator-side.',
    '- Do **not** modify `<worktree>/.forge/work-items/WI-*.md` — they are the developer-loop\'s output, you read them.',
    '- Stop after writing the demo bundle and `pr-description.md`. There is no further loop.',
  ]
    .filter((line) => line !== '')
    .join('\n');
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
