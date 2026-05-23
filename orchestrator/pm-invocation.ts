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

// Brain-index staleness window (documented, intentional — US-2.3 /
// brain-read-policy): this cache is module-level, so a long-running
// `forge serve` process keeps the brain index it loaded at boot. Themes
// written by cycle N are NOT visible to cycle N+1 until the process
// restarts. This is accepted, not a bug: the planner only needs a
// stable index within a cycle, and restarts are cheap. If per-cycle
// freshness is ever required, key the cache by cwd+mtime (as
// reflector-invocation.ts already keys by cwd) rather than adding an
// invalidation path. Do not "fix" this silently.
let cachedBrainIndex: string | null = null;
function loadBrainNavigation(cwd: string): string {
  if (cachedBrainIndex !== null) return cachedBrainIndex;
  cachedBrainIndex = loadBrainIndex({ cwd });
  return cachedBrainIndex;
}

/**
 * S8 / C23 — prompt caching intent.
 *
 * The PM system prompt has TWO sub-blocks with different cache lifetimes:
 *
 * - **Brain navigation index** (first block): stable for the lifetime of a
 *   forge process. Suitable for a 1-hour TTL marker —
 *   `cache_control: { type: 'ephemeral', ttl: '1h' }` (per C23). The 25% write
 *   premium amortises across every PM call in a multi-WI cycle (PM may run
 *   N>1 times across a long initiative).
 * - **`project-manager skill contract`** (second block): also stable, but
 *   shorter — 5-min ephemeral covers a single cycle's PM call cluster.
 *
 * The Claude Agent SDK v0.1.0 does NOT expose explicit `cache_control`
 * markers on its public surface (see `S8-DECISIONS.md` D1). Today the CLI
 * subprocess does prompt caching server-side keyed on prompt stability; this
 * file's job is to KEEP the prompt stable (no per-cycle timestamps, no
 * per-WI strings interpolated mid-prompt) so the cache hits naturally. The
 * `cacheable: true` flag on `createClaudeAgent` (and via this builder's
 * downstream wiring) carries the intent forward; the eventual marker shape
 * is documented here for the day the SDK exposes it.
 *
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
    '## Step 0 — Brain queries (REQUIRED, before any other action)',
    '',
    "**Your first tool calls MUST be `Read` against `brain/...` paths.** The orchestrator records which files you read; if zero of them are under `brain/`, the cycle aborts with a `pm.brain-skipped` error before validation even runs. The brain navigation index is in your system prompt above — use it to pick relevant theme files, then `Read` them in full. Do not infer or fabricate brain-theme content; you must have actually read the file.",
    '',
    'Required reads (minimum):',
    '- One or more `brain/forge/themes/*.md` covering work-item sizing, file-scope discipline, and feature-parallelism inheritance — these are the load-bearing PM-discipline patterns.',
    `- \`brain/projects/${input.projectName}/profile.md\` — taste signals for this project. Cite this in the WI body.`,
    `- Any \`brain/projects/${input.projectName}/themes/*.md\` whose description matches the initiative's domain.`,
    '',
    'Once read, proceed to the inputs and outputs below. The "Brain themes consulted" footer in each WI body must list paths you actually `Read`-ed.',
    '',
    '## Step 0.5 — Project structure enumeration (REQUIRED, before any WI emission)',
    '',
    "**You are running with `cwd` set to the project worktree.** All relative paths you pass to `Read` / `Glob` / `Grep` / `Write` resolve against the worktree directly — `Glob({pattern: 'src/**'})` enumerates THIS PROJECT'S src tree, not forge's. Use relative paths everywhere; do not prefix with the worktree path.",
    '',
    "**You MUST `Glob` the actual project tree before drafting any WI.** Hallucinated `files_in_scope` paths are the single largest source of dev-loop failure: the architect describes a project in narrative form, the PM agent invents plausible-but-fictional paths from generic priors (`src/engine/`, `src/core/`, `lib/`, etc.), and the dev agent then wastes budget either `mkdir -p`-ing the fabricated tree or hallucinating files inside it.",
    '',
    'Required reads (minimum) — run BEFORE drafting any WI:',
    "- `Glob({ pattern: \"src/**\" })` — enumerate the entire source tree",
    "- `Glob({ pattern: \"tests/**\" })` (or `spec/**`, `__tests__/**` — try the project's actual convention) — enumerate existing tests",
    "- `Read({ file_path: \"package.json\" })` (or `pyproject.toml`, `Cargo.toml` — match the project) — confirm scripts, deps, project type",
    "- `Read({ file_path: \"README.md\" })` and `CLAUDE.md` if present — project conventions",
    '',
    "Reconcile the architect's narrative against what's actually on disk:",
    "- If the architect says \"106 files in tests/\" and your Glob returns 12 files → the architect is wrong about scale OR the Glob pattern is wrong. Investigate before emitting WIs.",
    "- If the architect says a directory exists and your Glob returns nothing → the architect is wrong OR the worktree is missing it. Surface the discrepancy in your first WI's body and proceed against reality.",
    "- **Never invent files.** Every path you put in `files_in_scope` must either (a) appear in your Glob results, OR (b) be a new file your WI explicitly creates (and the AC's `then` clause says so).",
    '',
    `## Initiative: ${input.initiativeId}`,
    `## Project: ${input.projectName}`,
    '',
    '## Inputs',
    '',
    `- Initiative manifest: \`${input.manifestRelPath}\` (read this AFTER the brain queries AND after the structural Globs). Note this path is absolute or forge-root-relative — adjust if needed.`,
    `- Worktree: your current directory. Already enumerated in Step 0.5. Read individual files (key src/* modules, README, package.json scripts) before deciding the file-by-file scope of each WI. \`files_in_scope\` paths can be existing files (that the WI edits/moves) OR new files (that the WI creates) — both are fine; the dev-loop handles each.`,
    '',
    '## Output requirements',
    '',
    `- Write **one work-item file per atomic unit of work** to \`.forge/work-items/WI-<n>.md\` (cwd-relative). Use \`WI-1\`, \`WI-2\`, … contiguous and 1-indexed within this initiative.`,
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
    `- **Mandatory final step:** write \`.forge/work-items/_graph.md\` (cwd-relative) containing a single \`graph TD\` mermaid block. One node per work item (\`WI-N["<title>"]\`); edges run prerequisite → dependent and must agree exactly with the union of all \`depends_on\` lists. Budget for this — do not exhaust your turn budget before reaching this step.`,
    '',
    '## Self-check (last step before stopping)',
    '',
    'Walk this checklist explicitly before your final tool call. The orchestrator validates each WI; missing or malformed fields fail the cycle.',
    '',
    '**Per work item — frontmatter completeness:** open each `WI-<n>.md` and confirm the YAML frontmatter contains ALL of:',
    '- `work_item_id` (matches `WI-<n>` and the filename)',
    '- `feature_id` (matches a feature in the manifest)',
    `- \`initiative_id\` set exactly to \`${input.initiativeId}\``,
    '- `status: pending`',
    '- `depends_on` (array, possibly empty)',
    '- `acceptance_criteria` — at least 2 entries, each with `given` / `when` / `then`, all double-quoted',
    '- `files_in_scope` — at least 1 worktree-relative path, no leading `/`, must point at files that actually exist or will exist post-implementation',
    '- `estimated_iterations` — a positive integer (>= 1). Use 1 for trivial WIs, 2-3 for non-trivial.',
    '',
    "**Hidden-coupling check:** walk every pair of work items that share any file in `files_in_scope`. If neither item appears in the other's `depends_on` (transitively, in either direction), they will conflict at merge time — add the missing edge or merge them into one work item. This is non-negotiable; the bench scores it as `no_hidden_coupling` and the orchestrator now enforces it at runtime.",
    '',
    "**Brain-cite sanity check:** the body's \"Brain themes consulted\" footer should reference actual theme files you `Read`-ed in step 0. Don't fabricate citations — the orchestrator can detect a mismatch (cite that doesn't appear in your tool-use trace).",
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
