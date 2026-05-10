/**
 * Shared developer-loop invocation contract — system prompt + user prompt
 * builders + tool config.
 *
 * Both the bench harness (benchmarks/developer-loop/sdk.ts) and the live
 * orchestrator (orchestrator/cycle.ts:runDeveloperLoop) call into this module.
 * Single source of truth for what the developer agent sees, so the bench
 * reflects production.
 *
 * Contrast vs PM (orchestrator/pm-invocation.ts):
 *   - PM is a one-shot decomposition. The agent reads, plans, writes WIs once.
 *   - Developer is a Ralph loop. Each iteration is one SDK query() call; the
 *     loop carries state across iterations via PROMPT.md / AGENT.md / fix_plan.md
 *     in the worktree (stamped by loops/ralph/runner.ts:prepareWorkspace).
 *   - PM forbids Bash. The developer agent NEEDS Bash (run tests, run build,
 *     git commit) — the quality-gate verification still happens orchestrator-side
 *     (the agent's claim of "tests pass" is not trusted; carried-over v1 lesson),
 *     but the agent has to *try* to make tests pass, which means running them.
 *
 * The system prompt is set once when constructing the agent
 * (createClaudeAgent({ systemPrompt: buildDevSystemPrompt(...) })) and reused
 * across every iteration. The per-iteration content lives in PROMPT.md (which
 * the runner re-reads each iteration via claude-agent.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { loadBrainIndex } from './brain-index.ts';
import { parseWorkItem, type WorkItem } from './work-item.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const SKILL_PATH = resolve(FORGE_ROOT, 'skills', 'developer-ralph', 'SKILL.md');

export type DevAllowedTool = 'Read' | 'Write' | 'Edit' | 'MultiEdit' | 'Bash' | 'Grep' | 'Glob';
export type DevDisallowedTool = 'NotebookEdit' | 'WebFetch' | 'WebSearch';

export const DEV_ALLOWED_TOOLS: DevAllowedTool[] = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
];
export const DEV_DISALLOWED_TOOLS: DevDisallowedTool[] = ['NotebookEdit', 'WebFetch', 'WebSearch'];
export const DEV_MODEL = 'claude-sonnet-4-6';

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
 * Build the developer-loop system prompt: brain navigation index + the
 * SKILL.md contract + Ralph-loop discipline notes that don't change across
 * iterations.
 *
 * @param brainCwd - directory containing `brain/`. For the bench this is the
 *   tempdir (with symlinked brain/); for the live cycle this is the forge root.
 */
export function buildDevSystemPrompt(brainCwd: string): string {
  return [
    '# Brain navigation index',
    '',
    "Below are the brain's category indexes — every theme in scope, with a one-line description. Use these descriptions to identify candidate theme pages, then read those files in full to verify and extract precise terminology, project names, and patterns. The indexes ARE the retrieval index; you should rarely need grep.",
    '',
    loadBrainNavigation(brainCwd),
    '',
    '---',
    '',
    '# developer-ralph skill contract',
    '',
    loadSkillText(),
    '',
    '---',
    '',
    '# Ralph loop discipline',
    '',
    'You are inside a Ralph loop. Each call to you is **one iteration** of that loop. The loop carries state across iterations via three worktree files you must read at the start of every iteration:',
    '',
    '- **`PROMPT.md`** — the per-iteration brief (work item spec, acceptance criteria, files in scope, iteration counter).',
    '- **`AGENT.md`** — institutional memory across iterations. Read first, update last. Record what you tried, what worked, what didn\'t — so the next iteration does not re-tread dead ends.',
    '- **`fix_plan.md`** — checklist of acceptance criteria + sub-tasks. Tick items as you complete them; add items as you discover sub-problems.',
    '',
    'After your work this iteration, **commit** with a conventional-commits message (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Atomic commits — one concern per commit. You may use `Bash` for `git`, `npm test`, `pytest`, `bats`, or any test runner.',
    '',
    '**The orchestrator decides when to stop, not you.** It runs the project\'s quality gates between your iterations. Your job is to make incremental progress every iteration; the orchestrator exits the loop when gates pass, when the iteration / cost budget is exhausted, or when no progress is detected for several iterations (wedged).',
    '',
    'Hard rules:',
    '- **Brain-first (REQUIRED, mandatory).** Your first tool calls in iteration 1 of any work item MUST be one or more `Read`/`Grep`/`Glob` against `brain/...` paths. The orchestrator records `tool_use.brainReads` and **fails the WI if zero brain reads are recorded**. The brain navigation index is in this system prompt — pick the most relevant `brain/forge/themes/*.md` and `brain/projects/<project>/themes/*.md` files and Read them in full before drafting code. This is not "when unsure" — it is unconditional. Skipping is a hard fail.',
    '- **Files-in-scope.** The work item lists `files_in_scope`. Edit those files (and the test files explicitly listed). Do not modify unrelated files; flag scope-creep candidates in `AGENT.md` for the reflector to capture.',
    '- **No shortcuts.** Don\'t skip tests, don\'t `--no-verify`, don\'t disable lint rules to pass.',
    '- **No hallucinated test passes.** If you claim tests pass, prove it by running them via `Bash`. The orchestrator re-runs them anyway and will exit `failed` if your claim was wrong.',
  ].join('\n');
}

export type DevUserPromptInput = {
  initiativeId: string;
  workItemId: string;
  /** Worktree-relative path to the WI spec, e.g. `.forge/work-items/WI-1.md`. */
  workItemSpecRelPath: string;
  /** Worktree-relative path the agent runs in (usually `.`). */
  worktreeRelPath: string;
  iteration: number;
  iterationBudget: number;
  costBudgetUsd: number;
  filesInScope: string[];
  acceptanceCriteria: Array<{ given: string; when: string; then: string }>;
};

/**
 * Render a per-iteration prompt body. This is the content Ralph stamps into
 * PROMPT.md and re-reads each iteration. The runner (loops/ralph/runner.ts)
 * stamps from a template by default; this helper is provided so callers that
 * want to override the per-iteration body (e.g., tests injecting custom
 * scenarios) have a single source of truth.
 */
export function renderDevUserPrompt(input: DevUserPromptInput): string {
  const acChecklist = input.acceptanceCriteria
    .map(
      (c, i) =>
        `- [ ] AC${i + 1}: GIVEN ${c.given.trim()} WHEN ${c.when.trim()} THEN ${c.then.trim()}`,
    )
    .join('\n');
  const scopeList = input.filesInScope.map((f) => `- \`${f}\``).join('\n');
  return [
    `# Work Item — ${input.workItemId}`,
    '',
    `> Initiative: **${input.initiativeId}** · Iteration **${input.iteration}** of **${input.iterationBudget}** · Cost budget remaining: **$${input.costBudgetUsd.toFixed(2)}**`,
    '',
    '## Spec',
    '',
    `Read \`${input.workItemSpecRelPath}\` for the full work-item spec (acceptance criteria, body, frontmatter).`,
    '',
    '## Acceptance criteria',
    '',
    acChecklist,
    '',
    '## Files in scope',
    '',
    scopeList,
    '',
    '## Your task this iteration',
    '',
    '0. **Brain queries (REQUIRED, before any other tool call on iteration 1).** `Read` at least one `brain/forge/themes/*.md` (relevant patterns / antipatterns) AND at least one `brain/projects/<project>/themes/*.md` (or `profile.md`) for project taste. The orchestrator gates on this — zero `brain/...` reads = WI failure regardless of test status. Unconditional, not "when unsure". Cite the paths you read in `AGENT.md`\'s "Brain context" section.',
    '1. Read `AGENT.md` and `fix_plan.md`.',
    '2. Make progress on the highest-priority unchecked item in `fix_plan.md`.',
    '3. Run the project\'s quality gates with `Bash`. Don\'t claim a pass without running them.',
    '4. Commit your changes with a conventional-commits message.',
    '5. Update `fix_plan.md` to reflect what\'s done and what\'s left.',
    '6. Update `AGENT.md` with anything you learned that the next iteration should know.',
  ].join('\n');
}

export type PrepareDevWorkspaceInput = {
  initiativeId: string;
  /** Absolute path to the WI spec inside the worktree. */
  workItemSpecPath: string;
  /** Worktree-relative path to the WI spec, e.g. `.forge/work-items/WI-1.md`. */
  workItemSpecRelPath: string;
  /** Absolute path to the worktree the agent runs in. */
  worktreePath: string;
  /** Iteration budget for the loop (used in the prompt header). */
  iterationBudget: number;
  /** Cost budget for the loop (used in the prompt header). */
  costBudgetUsd: number;
  /** Brain-query results to seed AGENT.md with. v1 leaves this empty. */
  brainQueryResults?: string;
};

export type PreparedDevWorkspace = {
  workItem: WorkItem;
  promptPath: string;
  agentMdPath: string;
  fixPlanPath: string;
};

/**
 * Stamp a fully-rendered PROMPT.md, AGENT.md, and fix_plan.md into the
 * worktree from the WI spec. Idempotent — does not overwrite already-stamped
 * files (a re-entrant cycle inherits prior state). Both bench and live cycle
 * call this before `loops/ralph/runner.ts:run()`; the runner's own
 * `prepareWorkspace` is a fallback that uses raw templates when no caller has
 * pre-stamped the worktree.
 */
export function prepareDevWorkspace(input: PrepareDevWorkspaceInput): PreparedDevWorkspace {
  const promptPath = join(input.worktreePath, 'PROMPT.md');
  const agentMdPath = join(input.worktreePath, 'AGENT.md');
  const fixPlanPath = join(input.worktreePath, 'fix_plan.md');

  const workItem = parseWorkItem(readFileSync(input.workItemSpecPath, 'utf8'));

  if (!existsSync(promptPath)) {
    const prompt = renderDevUserPrompt({
      initiativeId: input.initiativeId,
      workItemId: workItem.work_item_id,
      workItemSpecRelPath: input.workItemSpecRelPath,
      worktreeRelPath: '.',
      iteration: 0,
      iterationBudget: input.iterationBudget,
      costBudgetUsd: input.costBudgetUsd,
      filesInScope: workItem.files_in_scope,
      acceptanceCriteria: workItem.acceptance_criteria,
    });
    writeFileSync(promptPath, prompt);
  }

  if (!existsSync(agentMdPath)) {
    const brainBlock = (input.brainQueryResults ?? '').trim() ||
      '_(no brain context seeded — read theme files yourself if needed; the system prompt has the navigation index.)_';
    writeFileSync(
      agentMdPath,
      [
        `# Agent Memory — ${workItem.work_item_id}`,
        '',
        '> Institutional memory for this work item across Ralph iterations. Read at the start of every iteration; updated at the end.',
        '',
        '## Brain context (loaded at iteration 1)',
        '',
        brainBlock,
        '',
        '## What I\'ve tried',
        '',
        '_(updated by each iteration — most recent at the top)_',
        '',
        '## What worked',
        '',
        '_(append patterns/approaches that produced progress)_',
        '',
        '## What didn\'t work',
        '',
        '_(append dead-ends so future iterations don\'t re-tread them)_',
        '',
        '## Open questions',
        '',
        '_(things that aren\'t blocking but would be useful to clarify; reflector picks these up)_',
        '',
        '## Notes for reflection',
        '',
        '_(observations the reflector should capture into the brain; the agent doesn\'t write them itself, but flags here)_',
        '',
      ].join('\n'),
    );
  }

  if (!existsSync(fixPlanPath)) {
    const checklist = workItem.acceptance_criteria
      .map((c, i) => `- [ ] AC${i + 1}: GIVEN ${c.given.trim()} WHEN ${c.when.trim()} THEN ${c.then.trim()}`)
      .join('\n');
    writeFileSync(
      fixPlanPath,
      [
        '# Fix Plan',
        '',
        `> Checklist for ${workItem.work_item_id}. Tick items as you complete them; add items as you discover sub-problems. The orchestrator uses this list (count of unchecked items) to detect when the loop is wedged.`,
        '',
        checklist,
        '',
      ].join('\n'),
    );
  }

  return { workItem, promptPath, agentMdPath, fixPlanPath };
}

/** Tool-use telemetry surfaced by both the bench and the live cycle. */
export type DevToolUseSummary = {
  reads: number;
  /**
   * Subset of `reads` whose tool input pointed at a `brain/...` path. Used by
   * the orchestrator's brain-first runtime gate (cycle.ts:assertBrainConsulted)
   * to enforce the SKILL.md mandate that every dev-loop WI consults the brain
   * before iterating.
   */
  brainReads: number;
  writes: number;
  bashCalls: number;
  testRuns: number;
};

const TEST_COMMAND_HEADS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'pytest',
  'python',
  'python3',
  'node',
  'bats',
  'go',
  'cargo',
  'mocha',
  'jest',
  'vitest',
]);

/**
 * Inspect a streamed assistant message and increment the summary in place.
 * `testRuns` is a heuristic counted from Bash calls whose first token suggests
 * a test runner (npm, pytest, node, etc.); informational only.
 */
export function tallyToolUse(
  message: { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined,
  summary: DevToolUseSummary,
): void {
  const blocks = message?.content ?? [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;
    const name = block.name ?? '';
    if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      summary.reads += 1;
      const blob = JSON.stringify(block.input ?? {});
      if (blob.includes('brain/') || blob.includes('"brain"')) summary.brainReads += 1;
    } else if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
      summary.writes += 1;
    } else if (name === 'Bash') {
      summary.bashCalls += 1;
      if (looksLikeTestRun(block.input)) summary.testRuns += 1;
    }
  }
}

function looksLikeTestRun(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd !== 'string') return false;
  const head = cmd.trim().split(/\s+/)[0] ?? '';
  return TEST_COMMAND_HEADS.has(head);
}
