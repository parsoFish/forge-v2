/**
 * Shared developer-unifier invocation contract — system prompt + per-iteration
 * prompt builder + workspace prep for the unifier sub-phase.
 *
 * The unifier is a final Ralph that runs after all per-WI Ralphs complete.
 * It owns the initiative-level acceptance criteria, the tracked demo bundle
 * at `<worktree>/demo/<initiative-id>/`, and the PR description draft at
 * `<worktree>/.forge/pr-description.md`. The cycle's developer-loop runner
 * invokes this contract; the SDK-backed Claude agent receives the
 * `buildUnifierSystemPrompt` output as its system prompt and reads
 * `PROMPT.md` (stamped by `prepareUnifierWorkspace`) at the start of every
 * iteration.
 *
 * CONTRACTS.md C3b: when `feedbackRef` is set, the per-iteration prompt
 * augments the brief with send-back semantics. C19: there is no $ cap; the
 * iteration cap (default 3) is the only bound — this module does not
 * expose any cost-related fields.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readWorkItemsFromDir } from './work-item.ts';
import type { DemoShape } from './project-config.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const SKILL_PATH = resolve(FORGE_ROOT, 'skills', 'developer-unifier', 'SKILL.md');

export type UnifierAllowedTool =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'MultiEdit'
  | 'Bash'
  | 'Grep'
  | 'Glob';
export type UnifierDisallowedTool = 'NotebookEdit' | 'WebFetch' | 'WebSearch';

export const UNIFIER_ALLOWED_TOOLS: UnifierAllowedTool[] = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
];
export const UNIFIER_DISALLOWED_TOOLS: UnifierDisallowedTool[] = [
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];
export const UNIFIER_MODEL = 'claude-sonnet-4-6';

/** Default unifier iteration cap per CONTRACTS.md C19 (no $ cap; iteration cap is the only bound). */
export const UNIFIER_DEFAULT_ITERATION_CAP = 3;

let cachedSkillText: string | null = null;
function loadSkillText(): string {
  if (cachedSkillText !== null) return cachedSkillText;
  cachedSkillText = readFileSync(SKILL_PATH, 'utf8');
  return cachedSkillText;
}

/**
 * Build the unifier system prompt: the SKILL.md contract plus Ralph
 * discipline notes. Identical shape to `buildDevSystemPrompt` so the SDK
 * adapter can be reused unchanged.
 */
export function buildUnifierSystemPrompt(): string {
  return [
    '# developer-unifier skill contract',
    '',
    loadSkillText(),
    '',
    '---',
    '',
    '# Ralph loop discipline (unifier sub-phase)',
    '',
    'You are inside a **Ralph loop** running on the initiative branch AFTER all per-WI Ralphs have completed. Each call to you is **one iteration**. The loop carries state via three worktree files you must read at the start of every iteration:',
    '',
    '- **`PROMPT.md`** — the per-iteration brief (initiative ID, manifest path, demo shape, iteration counter, optional send-back feedback reference).',
    '- **`AGENT.md`** — institutional memory across iterations. Read first, update last.',
    '- **`fix_plan.md`** — checklist of initiative-level ACs. Tick items as you prove each one against the branch tip.',
    '',
    'After your work this iteration, **commit** with `feat(<initiative-id>): unify and demo` (or `fix(<initiative-id>): address review round <N>` in send-back mode). Atomic commits — one concern per commit. You may use `Bash` for `git`, the quality gate, the demo runner, etc.',
    '',
    '**The orchestrator decides when to stop, not you.** It runs four composed gates between your iterations:',
    '1. `initiative_gate` — the project quality-gate command against the whole branch.',
    '2. `demo_runs_clean` — the project demo-command exits 0 (excused for shape "none").',
    '3. `pr_self_contained` — `demo/<initiative-id>/DEMO.md` exists, `.forge/pr-description.md` ≥ 300 chars with a `## Demo` block.',
    '4. `branches_in_sync` — `origin/<branch>` == local HEAD; main == merge-base.',
    '',
    'All four must pass for the unifier to exit clean. Cap: 3 iterations (no $ cap per CONTRACTS.md C19).',
    '',
    'Hard rules:',
    '- **Scope discipline.** Files you may modify are the union of all WIs\' `files_in_scope` plus the tracked demo path (`demo/<initiative-id>/**`) plus `.forge/pr-description.md`. Anything else is a scope violation; flag in `AGENT.md` for the reflector.',
    '- **No `gh pr create`, no `gh pr merge`.** The review phase opens the PR from your output.',
    '- **No queue mutation.** `_queue/` is read-only; in send-back mode the feedback file is your input, not your output.',
    '- **No shortcuts.** Don\'t skip tests, don\'t `--no-verify`, don\'t disable lint rules to pass.',
    '- **No hallucinated test passes.** If you claim tests pass, prove it via `Bash`. The orchestrator re-runs them and exits failed if your claim was wrong.',
  ].join('\n');
}

export type UnifierUserPromptInput = {
  initiativeId: string;
  /** Worktree-relative path to the initiative manifest. */
  manifestRelPath: string;
  /** Worktree-relative paths of every WI spec the initiative contains. */
  workItemSpecs: string[];
  iteration: number;
  iterationBudget: number;
  demoShape: DemoShape;
  qualityGateCmd: string[];
  /**
   * Optional path to a C3a `pr-feedback.md`. When set, the unifier is in
   * send-back mode (C3b) and the prompt augments accordingly.
   */
  feedbackRef: string | undefined;
};

/**
 * Render the per-iteration prompt body that gets stamped into PROMPT.md.
 * The runner re-reads PROMPT.md every iteration; this is the body the
 * agent sees as "Iteration N — what to do this round".
 */
export function renderUnifierUserPrompt(input: UnifierUserPromptInput): string {
  const sendBackMode = input.feedbackRef !== undefined;
  const wiList = input.workItemSpecs.length > 0
    ? input.workItemSpecs.map((p) => `- \`${p}\``).join('\n')
    : '- _(no work items recorded; consult the manifest body)_';

  const demoBlock = demoInstructionsForShape(input.demoShape);
  const sendBackBlock = sendBackMode
    ? [
        '',
        '## Send-back mode (CONTRACTS.md C3b)',
        '',
        `This is a send-back round. Read \`${input.feedbackRef}\` (C3a schema: line-level + PR-level review comments) and address each comment by file/line. Commit. Push. Do not exceed the iteration cap. Do not add scope beyond what the comments request.`,
        '',
        'After addressing the comments, post an ack comment on the PR:',
        '',
        '```',
        'gh pr comment --body "<!-- forge:verdict-ack --> addressed: <brief summary>"',
        '```',
        '',
      ].join('\n')
    : '';

  return [
    '# Developer-unifier — iteration brief',
    '',
    `> Initiative: **${input.initiativeId}** · Iteration **${input.iteration}** of **${input.iterationBudget}** · Demo shape: **${input.demoShape}**`,
    '',
    '## Inputs',
    '',
    `- Initiative manifest: \`${input.manifestRelPath}\`.`,
    `- Quality-gate command: \`${input.qualityGateCmd.join(' ')}\`.`,
    '- Per-WI specs:',
    wiList,
    '- `AGENT.md` — institutional memory + prior iteration notes.',
    '- `fix_plan.md` — initiative-level AC checklist.',
    sendBackMode ? `- Feedback ref: \`${input.feedbackRef}\` (read this BEFORE writing any code).` : '',
    sendBackBlock,
    '## What to do this iteration',
    '',
    sendBackMode
      ? [
          '1. **Read AGENT.md, fix_plan.md, and the feedback file.**',
          '2. **Address each comment** in the feedback file. If a comment maps to `path:line`, edit that file. If a comment is general (PR-level), update the PR body or add a `## Notes` section.',
          '3. **Re-run the quality gate.** Fix anything that breaks.',
          '4. **Refresh the demo** if the change is user-visible.',
          '5. **Commit** as `fix(<initiative-id>): address review round <N>`.',
          '6. **Push** the branch.',
          '7. **Post the ack comment** on the PR.',
          '8. **Update AGENT.md** with what you addressed.',
        ].join('\n')
      : [
          '1. **Read AGENT.md and fix_plan.md.**',
          `2. **Read each WI spec** to know the union of files_in_scope (your scope ceiling).`,
          `3. **Run the quality gate**: \`${input.qualityGateCmd.join(' ')}\`. If red, fix within scope.`,
          '4. **Produce the demo** under `demo/<initiative-id>/`:',
          demoBlock,
          '5. **Write `.forge/pr-description.md`** — `## Why` (≥ 50 chars), `## What`, `## How`, `## Demo` (relative link to `demo/<initiative-id>/DEMO.md`). Total body ≥ 300 chars. Anchor on `git log` + `git diff --stat main...HEAD`.',
          '6. **Commit** as `feat(<initiative-id>): unify and demo`. Skip the commit if no changes were made.',
          '7. **Push** the branch so `origin/<branch>` == local HEAD.',
          '8. **Update AGENT.md** with what you did this iteration.',
        ].join('\n'),
    '',
    '## Constraints',
    '',
    '- Scope ceiling: union of all WIs\' `files_in_scope` ∪ `demo/<initiative-id>/**` ∪ `.forge/pr-description.md`.',
    '- Iteration cap: **3** (no $ cap per CONTRACTS.md C19).',
    '- Do **NOT** call `gh pr create` or `gh pr merge`.',
    '- After completing this iteration, **stop**.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function demoInstructionsForShape(shape: DemoShape): string {
  switch (shape) {
    case 'browser':
      return [
        '   - Write a Playwright spec (e.g. `demo/<initiative-id>/demo.spec.ts`).',
        '   - Run the project\'s preview command in the background, then `npx playwright test --trace=on`.',
        '   - Capture screenshots/videos under `demo/<initiative-id>/`.',
        '   - Write `demo/<initiative-id>/DEMO.md` with relative-link images.',
      ].join('\n');
    case 'harness':
      return [
        '   - Run the project\'s demo command (typically a test harness) against baseline AND HEAD.',
        '   - Scrape stable, regex-extractable result lines from each run.',
        '   - Write a before/after table to `demo/<initiative-id>/DEMO.md`. No media required.',
      ].join('\n');
    case 'cli-diff':
      return [
        '   - Run the project\'s demo command twice (baseline and HEAD).',
        '   - Capture stdout from each; render a unified diff into `demo/<initiative-id>/DEMO.md`.',
      ].join('\n');
    case 'artifact':
      return [
        '   - Run the project\'s demo command; capture the produced file or stdout block.',
        '   - Embed it inline in `demo/<initiative-id>/DEMO.md`.',
      ].join('\n');
    case 'none':
      return [
        '   - This is an infra-only initiative. No media required.',
        '   - Write `demo/<initiative-id>/DEMO.md` as a rationale block: "what would a reviewer have to grep to convince themselves this works", with a short justification.',
      ].join('\n');
  }
}

export type PrepareUnifierWorkspaceInput = {
  initiativeId: string;
  /** Worktree-relative manifest path. */
  manifestRelPath: string;
  /** Absolute path to the worktree the agent runs in. */
  worktreePath: string;
  iterationBudget: number;
  demoShape: DemoShape;
  qualityGateCmd: string[];
  /** Optional send-back feedback file path (per C3b). */
  feedbackRef: string | undefined;
};

export type PreparedUnifierWorkspace = {
  promptPath: string;
  agentMdPath: string;
  fixPlanPath: string;
};

/**
 * Stamp PROMPT.md, AGENT.md, and fix_plan.md for the unifier sub-phase.
 * Idempotent — does not overwrite already-stamped files (a re-entrant
 * cycle inherits prior state).
 *
 * The fix_plan.md is initialised from the initiative's WI ACs so the
 * agent has a single checklist to tick.
 */
export function prepareUnifierWorkspace(
  input: PrepareUnifierWorkspaceInput,
): PreparedUnifierWorkspace {
  const promptPath = join(input.worktreePath, 'PROMPT.md');
  const agentMdPath = join(input.worktreePath, 'AGENT.md');
  const fixPlanPath = join(input.worktreePath, 'fix_plan.md');

  // Collect every WI spec under .forge/work-items/ for the prompt.
  const workItemsDir = join(input.worktreePath, '.forge', 'work-items');
  const wiSpecs: string[] = [];
  const acCriteria: Array<{ wi: string; given: string; when: string; then: string }> = [];
  if (existsSync(workItemsDir)) {
    const { items } = readWorkItemsFromDir(workItemsDir);
    for (const wi of items) {
      wiSpecs.push(`.forge/work-items/${wi.work_item_id}.md`);
      for (const ac of wi.acceptance_criteria) {
        acCriteria.push({ wi: wi.work_item_id, given: ac.given, when: ac.when, then: ac.then });
      }
    }
  }

  if (!existsSync(promptPath)) {
    const prompt = renderUnifierUserPrompt({
      initiativeId: input.initiativeId,
      manifestRelPath: input.manifestRelPath,
      workItemSpecs: wiSpecs,
      iteration: 1,
      iterationBudget: input.iterationBudget,
      demoShape: input.demoShape,
      qualityGateCmd: input.qualityGateCmd,
      feedbackRef: input.feedbackRef,
    });
    writeFileSync(promptPath, prompt);
  }

  if (!existsSync(agentMdPath)) {
    writeFileSync(
      agentMdPath,
      [
        `# Unifier Agent Memory — ${input.initiativeId}`,
        '',
        '> Institutional memory across unifier-Ralph iterations. Read at the start of every iteration; updated at the end.',
        '',
        '## What I tried',
        '',
        '_(updated by each iteration — most recent at the top)_',
        '',
        '## Notes for reflection',
        '',
        '_(observations the reflector should capture into the brain)_',
        '',
      ].join('\n'),
    );
  }

  if (!existsSync(fixPlanPath)) {
    const checklist = acCriteria.length > 0
      ? acCriteria
          .map(
            (ac, i) =>
              `- [ ] AC${i + 1} (${ac.wi}): GIVEN ${ac.given.trim()} WHEN ${ac.when.trim()} THEN ${ac.then.trim()}`,
          )
          .join('\n')
      : '- [ ] _(no acceptance criteria found in WI specs; consult manifest)_';
    writeFileSync(
      fixPlanPath,
      [
        '# Fix Plan — unifier sub-phase',
        '',
        '> Initiative-level acceptance criteria. Tick each as you prove it against branch tip. Iteration 1 is initial prep; iterations 2+ react to either gate failures or send-back feedback.',
        '',
        checklist,
        '',
      ].join('\n'),
    );
  }

  // Ensure the .forge/ scratch dir exists for pr-description.md authoring.
  const forgeDir = join(input.worktreePath, '.forge');
  if (!existsSync(forgeDir)) mkdirSync(forgeDir, { recursive: true });

  return { promptPath, agentMdPath, fixPlanPath };
}
