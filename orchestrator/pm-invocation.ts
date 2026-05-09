/**
 * Shared PM invocation contract — system prompt + user prompt builders.
 *
 * Both the bench harness (benchmarks/project-manager/sdk.ts) and the live
 * orchestrator (orchestrator/cycle.ts:runProjectManager) call into this module.
 * Single source of truth for what the PM sees, so the bench reflects production.
 *
 * The system prompt = brain navigation index + skills/project-manager/SKILL.md.
 * The user prompt = a per-cycle, per-initiative briefing telling the agent
 * exactly where the manifest lives, where the worktree lives, and where to
 * write outputs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadBrainIndex } from './brain-index.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const SKILL_PATH = resolve(FORGE_ROOT, 'skills', 'project-manager', 'SKILL.md');

export type PmAllowedTool = 'Read' | 'Grep' | 'Glob' | 'Write' | 'Edit';
export type PmDisallowedTool = 'Bash' | 'NotebookEdit' | 'WebFetch' | 'WebSearch';

export const PM_ALLOWED_TOOLS: PmAllowedTool[] = ['Read', 'Grep', 'Glob', 'Write', 'Edit'];
export const PM_DISALLOWED_TOOLS: PmDisallowedTool[] = ['Bash', 'NotebookEdit', 'WebFetch', 'WebSearch'];
export const PM_MODEL = 'claude-sonnet-4-6';

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
 * Build the PM system prompt: brain navigation index + the SKILL.md contract.
 *
 * @param brainCwd - directory containing `brain/`. For the bench this is the
 *   tempdir (with symlinked brain/); for the live cycle this is the forge root.
 */
export function buildPmSystemPrompt(brainCwd: string): string {
  return [
    '# Brain navigation index',
    '',
    "Below are the brain's category indexes — every theme in scope, with a one-line description. Use these descriptions to identify candidate theme pages, then read those files in full to verify and extract precise terminology, project names, and patterns. The indexes ARE the retrieval index; you should rarely need grep.",
    '',
    loadBrainNavigation(brainCwd),
    '',
    '---',
    '',
    '# project-manager skill contract',
    '',
    loadSkillText(),
  ].join('\n');
}

export type PmUserPromptInput = {
  initiativeId: string;
  /** Path to the initiative manifest, relative to the cwd the SDK runs in. */
  manifestRelPath: string;
  /** Path to the worktree where work items will be written, relative to cwd. */
  worktreeRelPath: string;
  projectName: string;
  /** Lower bound on work-item count (inclusive). Used as a discipline anchor. */
  minWorkItems: number;
  /** Upper bound on work-item count (inclusive). Used as an over-decomposition cap. */
  maxWorkItems: number;
  /**
   * Minimum fraction (0-1) of work items that should be parallelisable
   * (no `depends_on`). Used as a discipline anchor against linear chains.
   */
  parallelFractionAtLeast: number;
};

/**
 * Render the per-fixture / per-cycle user prompt the SDK sends to the agent.
 * Tells the agent the cwd-relative paths, the count target, and reiterates
 * the contract (brain-first, Given-When-Then, files_in_scope, _graph.md).
 */
export function renderPmUserPrompt(input: PmUserPromptInput): string {
  return [
    '# Project-manager invocation',
    '',
    'You are running non-interactively. Decompose the initiative into atomic work items and write them to disk. **You MUST write at least one work-item file before stopping; finishing without writing files is a failed run.** Do not ask clarifying questions; if something is genuinely under-specified in the manifest, infer the most reasonable choice, note it in the work-item body, and proceed.',
    '',
    `## Initiative: ${input.initiativeId}`,
    `## Project: ${input.projectName}`,
    '',
    '## Inputs',
    '',
    `- Initiative manifest: \`${input.manifestRelPath}\` (read this first, after the brain queries).`,
    `- Worktree: \`${input.worktreeRelPath}/\` — read its README, source layout, and existing tests so your \`files_in_scope\` choices are real paths in this project.`,
    '',
    '## Output requirements',
    '',
    `- Write **one work-item file per atomic unit of work** to \`${input.worktreeRelPath}/.forge/work-items/WI-<n>.md\`. Use \`WI-1\`, \`WI-2\`, … contiguous and 1-indexed within this initiative.`,
    `- Produce **${input.minWorkItems}–${input.maxWorkItems}** work items. Hard floor: ${input.minWorkItems}. If your draft has fewer, the initiative is under-decomposed — break a feature into smaller steps (data-shape change → algorithm → integration → tests is a common split). If your draft has more than ${input.maxWorkItems}, you've over-decomposed; merge the smallest items.`,
    `- At least **${Math.round(input.parallelFractionAtLeast * 100)}%** of the work items must have an empty \`depends_on\` (i.e., be runnable in parallel from the start). Linear chains are an antipattern — find the independent slices.`,
    "- **Inherit feature parallelism from the manifest.** Read each feature's `depends_on` field. If two manifest features have no edge connecting them (e.g., FEAT-2 and FEAT-3 both `depends_on: [FEAT-1]` but neither depends on the other), the work items implementing them MUST also be independent — no `depends_on` between FEAT-2's WIs and FEAT-3's WIs. The architect's feature graph is your skeleton; the WI graph refines it but does not over-serialise it. Putting a parallel pair into a chain is the most common PM antipattern and the one v1 trafficGame data flagged as causing 48% of job failures.",
    '- **File-scope discipline (load-bearing).** If two WIs would both edit the same file, choose in this priority order: (1) **Best — split the file** along the dimension that distinguishes the WIs (one file per impl; one file per concern; e.g., a `MergeStrategy` interface with `layered.ts` and `stacked.ts` siblings, not two impls jammed into the same `merge-strategy.ts`). (2) **Acceptable — merge the WIs** into one. (3) **Last resort — add a `depends_on` edge** serialising them. Two WIs touching the same file with no edge between them is a guaranteed merge conflict and fails `no_hidden_coupling`. Look at the worktree layout: if the existing code already has separate files per concern, mirror that.',
    '- Frontmatter (locked by ADR 015) — exactly these fields, all required:',
    '  ```yaml',
    '  ---',
    '  work_item_id: WI-<n>',
    '  feature_id: FEAT-<n>          # must exist in the manifest',
    `  initiative_id: ${input.initiativeId}`,
    '  status: pending',
    '  depends_on: [WI-...]          # empty array if independent',
    '  acceptance_criteria:',
    '    - given: "<precondition>"',
    '      when:  "<action>"',
    '      then:  "<observable outcome>"',
    '  files_in_scope:               # worktree-relative paths (no leading /)',
    '    - <path>',
    '  estimated_iterations: <int>   # > 0',
    '  ---',
    '  ```',
    '- **YAML quoting (load-bearing):** wrap every `given` / `when` / `then` value in double quotes. YAML 1.2 reserves the leading characters `` ` `` `?` `!` `&` `*` `@` `%` for indicators; an unquoted value starting with any of these — for example `` when:  `cargo build` is run `` — fails to parse. Always-quoting eliminates the entire class of escape bugs. Same rule for any value containing a colon-space (`: `).',
    '- Body: free-form markdown rationale. Cite the brain theme(s) you consulted by path. **No code blocks containing implementations** — acceptance criteria are the contract; the developer loop writes the code.',
    `- **Mandatory final step:** write \`${input.worktreeRelPath}/.forge/work-items/_graph.md\` containing a single \`graph TD\` mermaid block. One node per work item (\`WI-N["<title>"]\`); edges run prerequisite → dependent and must agree exactly with the union of all \`depends_on\` lists. Budget for this — do not exhaust your turn budget before reaching this step.`,
    '',
    '## Self-check (last step before stopping)',
    '',
    "Walk every pair of work items that share any file in `files_in_scope`. If neither item appears in the other's `depends_on` (transitively, in either direction), they will conflict at merge time — add the missing edge or merge them into one work item. This is non-negotiable; the bench scores it as `no_hidden_coupling`.",
    '',
    'Do not update the manifest frontmatter or status — leave that to the orchestrator. Just write the work items and the graph, then stop.',
  ].join('\n');
}

/** Tool-use telemetry surfaced by both the bench and the live cycle. */
export type PmToolUseSummary = {
  brainReads: number;
  writes: number;
  bashCalls: number;
};

/**
 * Inspect a streamed assistant message and increment the summary in place.
 * Same heuristic the architect bench uses: brain reads detected by inspecting
 * tool-input for `brain/` references; writes/edits/bash counted by tool name.
 */
export function tallyToolUse(
  message: { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined,
  summary: PmToolUseSummary,
): void {
  const blocks = message?.content ?? [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;
    const name = block.name ?? '';
    if (name === 'Write' || name === 'Edit') {
      summary.writes += 1;
    } else if (name === 'Bash') {
      summary.bashCalls += 1;
    } else if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      const blob = JSON.stringify(block.input ?? {});
      if (blob.includes('brain/') || blob.includes('"brain"')) summary.brainReads += 1;
    }
  }
}
