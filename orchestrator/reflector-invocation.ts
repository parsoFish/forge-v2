/**
 * Shared reflector invocation contract — system prompt + user prompt builders +
 * tool config.
 *
 * Both the bench harness (benchmarks/reflection/sdk.ts) and the live
 * orchestrator (orchestrator/cycle.ts:runReflector) call into this module.
 * Single source of truth for what the reflector agent sees, so the bench
 * reflects production exactly.
 *
 * The reflector is a **one-shot SDK invocation** (not a Ralph loop) that runs
 * after a successful merge. It consumes the cycle's event log + closed manifest
 * + merged tree and emits brain theme updates that feed future cycles.
 *
 * Stages 2 + 3 (interactive user-Q&A) use **file-based handoff**, not turn-by-
 * turn chat: the agent writes its questions into `user-questions.md`, then
 * reads `user-feedback.md` (canned by the bench simulator; written by a real
 * user in production). Stdin/CLI transport is deferred.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadBrainIndex } from './brain-index.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');
const SKILL_PATH = resolve(FORGE_ROOT, 'skills', 'reflector', 'SKILL.md');

export type ReflectorAllowedTool = 'Read' | 'Grep' | 'Glob' | 'Write' | 'Edit' | 'Bash';
export type ReflectorDisallowedTool = 'NotebookEdit' | 'WebFetch' | 'WebSearch';

export const REFLECTOR_ALLOWED_TOOLS: ReflectorAllowedTool[] = [
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'Bash',
];
export const REFLECTOR_DISALLOWED_TOOLS: ReflectorDisallowedTool[] = [
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

/**
 * Reflector workload is summarisation + write — not opus-justifying. Match
 * every other live phase. The SKILL.md frontmatter `model: claude-opus-4-7`
 * is aspirational; this constant is the live default. Promote later by
 * changing one line.
 */
export const REFLECTOR_MODEL = 'claude-sonnet-4-6';

let cachedSkillText: string | null = null;
function loadSkillText(): string {
  if (cachedSkillText !== null) return cachedSkillText;
  cachedSkillText = readFileSync(SKILL_PATH, 'utf8');
  return cachedSkillText;
}

let cachedBrainIndex: string | null = null;
let cachedBrainIndexCwd: string | null = null;
function loadBrainNavigation(cwd: string): string {
  if (cachedBrainIndex !== null && cachedBrainIndexCwd === cwd) return cachedBrainIndex;
  cachedBrainIndex = loadBrainIndex({ cwd });
  cachedBrainIndexCwd = cwd;
  return cachedBrainIndex;
}

/**
 * S8 / C23 — prompt caching intent.
 *
 * Reflector is a **one-shot** call per cycle (not a Ralph loop). The
 * caching win here is across CYCLES, not within a single call: the SKILL.md
 * contract block + the brain navigation index are stable from one cycle to
 * the next. With the Claude Code CLI's server-side caching (which the SDK
 * uses transparently), the second reflector call within the TTL window
 * reads from cache.
 *
 * The Claude Agent SDK v0.1.0 does NOT expose explicit
 * `cache_control: { type: 'ephemeral' }` markers — see `S8-DECISIONS.md` D1
 * for the gap analysis. The work this file does to make caching effective:
 * KEEP the system prompt stable. Per-cycle data (cycle id, manifest paths,
 * worktree paths) goes in the USER prompt — never mid system prompt —
 * exactly so the cache key holds.
 *
 * TTL: 5-min ephemeral. Reflector calls are spaced apart by full
 * cycles (typically > 5 min), so a longer TTL would just inflate the write
 * premium without enough hits to amortise. Cycles that fire back-to-back DO
 * still benefit from the within-window cache hit.
 *
 * Build the reflector system prompt: brain navigation index + the SKILL.md
 * contract + reflector-specific discipline notes (file-based handoff,
 * direct-write themes, evidence-grounding requirement).
 *
 * @param brainCwd - directory containing `brain/`. For the bench this is the
 *   tempdir (with symlinked brain/); for the live cycle this is the forge root.
 */
export function buildReflectorSystemPrompt(brainCwd: string): string {
  return [
    '# Brain navigation index',
    '',
    "Below are the brain's category indexes. Use these descriptions to identify candidate theme pages, then read those files in full to verify and extract precise terminology, project names, and patterns. The indexes ARE the retrieval index; you should rarely need grep.",
    '',
    loadBrainNavigation(brainCwd),
    '',
    '---',
    '',
    '# reflector skill contract',
    '',
    loadSkillText(),
    '',
    '---',
    '',
    '# Reflector discipline (this closure pass)',
    '',
    'You are a **one-shot reflector** — not a Ralph loop. Run the four-stage process described in the skill contract, then exit. The orchestrator does not call you a second time.',
    '',
    '**File-based interactivity (stages 2 + 3).** You do NOT call `AskUserQuestion`. Instead:',
    '- **Stage 2**: write your structured questions (max 4) into `_logs/<cycle-id>/user-questions.md`. One numbered question per heading. Skip stage 2 entirely if you cannot identify any non-brain-resolvable questions.',
    '- **Stage 3**: after writing questions, read `_logs/<cycle-id>/user-feedback.md`. This file is pre-populated (by the bench simulator or by the user before the next cycle). Treat its contents as the user\'s answers + free-form feedback, and incorporate them into `retro.md` Section 2 + Section 3.',
    '- If `user-feedback.md` does not exist when you go to read it, write retro.md sections 2 + 3 as `_(no feedback supplied this cycle)_` and continue.',
    '',
    '**Direct-write brain.** Write theme markdown files directly to `brain/projects/<project>/themes/<YYYY-MM-DD>-<slug>.md`. Required frontmatter: `title`, `description`, `category` (one of `pattern`, `antipattern`, `decision`, `operation`, `reference`), `created_at`, `updated_at`. The brain-ingest sub-skill is NOT invoked in this pass.',
    '',
    '**Evidence grounding (load-bearing).** Every theme MUST include a `## Sources` section listing ≥ 1 path that resolves to either:',
    '- `_logs/<cycle-id>/...` (event log entries you cited), or',
    '- `brain/_raw/cycles/<cycle-id>.md` (the cycle archive you wrote).',
    '',
    'Themes without resolvable sources fail the bench\'s evidence-grounding criterion. Vague observations ("we could improve X") are rejected.',
    '',
    '**Cycle archive (mandatory).** Write `brain/_raw/cycles/<cycle-id>.md` with frontmatter:',
    '```yaml',
    '---',
    'source_type: cycle',
    'source_url: _logs/<cycle-id>/events.jsonl',
    'source_title: Cycle <cycle-id> — Initiative <initiative-id>',
    'cycle_id: <cycle-id>',
    'initiative_id: <initiative-id>',
    'project: <project>',
    'ingested_at: <ISO-8601 timestamp>',
    'ingested_by: reflector',
    '---',
    '```',
    'Body: a short summary plus the full event-log excerpt (or a link to it).',
    '',
    '**Retro structure.** `_logs/<cycle-id>/retro.md` MUST contain three structural headings:',
    '- `## Self-reflection` — what you noticed (stage 1).',
    '- `## User questions` — questions you wrote, plus answers from `user-feedback.md` (stage 2).',
    '- `## User feedback` — free-form user input from `user-feedback.md` (stage 3).',
    '',
    '**Brain-query first (REQUIRED, mandatory).** Your first tool calls MUST be `Read`/`Grep`/`Glob` against `brain/...` paths — at minimum `brain/projects/<project>/profile.md` and any prior `brain/projects/<project>/themes/*.md` whose description matches a pattern you observed in the event log. The orchestrator records `tool_use.brainReads` and **fails the reflection if zero brain reads are recorded**. This is unconditional, not "when unsure". The bench AND production both gate on this signal.',
    '',
    'Hard rules:',
    '- **No `gh` operations.** The reviewer already merged. Reflection is post-merge log-and-continue.',
    '- **No queue mutation.** `_queue/done/` already contains the manifest (the reviewer moved it). Read-only for you.',
    '- **No WI-spec edits.**',
    '- **No web tools.** `WebFetch` / `WebSearch` are disabled.',
    '- **Concrete actions, not vague intentions.** Themes must capture specific patterns / antipatterns / decisions, not platitudes.',
  ].join('\n');
}

export type ReflectorUserPromptInput = {
  initiativeId: string;
  cycleId: string;
  /** Path to the closed manifest in `_queue/done/`. */
  manifestRelPath: string;
  /** Path to the cycle's structured event log. */
  eventLogRelPath: string;
  /** Path to brain-gaps.jsonl (may reference a non-existent file — agent tolerates). */
  brainGapsRelPath: string;
  /** Read-only path to the merged project tree (for evidence inspection). */
  mergedTreeRelPath: string;
  projectName: string;
  /** Path the reflector writes its stage-2 questions to. */
  userQuestionsRelPath: string;
  /** Path the reflector reads stage-3 user feedback from (pre-populated). */
  userFeedbackRelPath: string;
  /** Path the reflector writes its retro to. */
  retroRelPath: string;
  /** Where to write the cycle archive. Includes filename. */
  cycleArchiveRelPath: string;
  /**
   * Where to write theme files. The reflector decides per-theme filenames; this
   * is the directory root.
   */
  themesDirRelPath: string;
};

/**
 * Render the per-cycle prompt body the reflector reads. Walks the agent through
 * the four-stage process with concrete file paths.
 */
export function renderReflectorUserPrompt(input: ReflectorUserPromptInput): string {
  return [
    '# Reflection brief',
    '',
    `> Initiative: **${input.initiativeId}** · Cycle: **${input.cycleId}** · Project: **${input.projectName}**`,
    '',
    '## Inputs',
    '',
    `- Closed manifest: \`${input.manifestRelPath}\``,
    `- Cycle event log: \`${input.eventLogRelPath}\``,
    `- Brain-gaps log: \`${input.brainGapsRelPath}\` (may not exist if the cycle had zero gaps)`,
    `- Merged project tree (read-only): \`${input.mergedTreeRelPath}/\``,
    '',
    '## Outputs (paths are pre-resolved; do NOT change them)',
    '',
    `- Retro: \`${input.retroRelPath}\` — three sections (\`## Self-reflection\`, \`## User questions\`, \`## User feedback\`).`,
    `- User questions (stage 2): \`${input.userQuestionsRelPath}\` — at most 4 numbered questions. Skip if none warranted.`,
    `- User feedback to read (stage 3 input): \`${input.userFeedbackRelPath}\` — pre-populated; if missing, treat as no feedback.`,
    `- Cycle archive: \`${input.cycleArchiveRelPath}\` — frontmatter mandatory.`,
    `- Theme files: \`${input.themesDirRelPath}/<YYYY-MM-DD>-<slug>.md\` — at least one per significant pattern.`,
    '',
    '## What to do',
    '',
    '1. **Brain query** — run `brain-query` for prior retros, antipatterns surfaced, and outstanding gaps.',
    `2. **Stage 1 (self-reflection)**: read \`${input.eventLogRelPath}\` end-to-end. Compute iterations, costs, wedge events, send-back rounds, brain-gap counts. Identify 2-5 patterns/antipatterns worth capturing. Draft \`${input.retroRelPath}\` Section 1.`,
    `3. **Stage 2 (user questions)**: write \`${input.userQuestionsRelPath}\` with the questions you can\'t answer from the brain alone. Cap at 4. Skip the file entirely if no such questions exist.`,
    `4. **Stage 3 (user feedback)**: read \`${input.userFeedbackRelPath}\`. If it exists, distil the answers into Section 2 of \`${input.retroRelPath}\` and the free-form feedback into Section 3. If missing, write \`_(no feedback supplied this cycle)_\` for both.`,
    `5. **Cycle archive**: write \`${input.cycleArchiveRelPath}\` with the frontmatter shown in the system prompt. Body: short summary + reference to the event log.`,
    `6. **Themes**: for each pattern/antipattern from Stage 1, write a theme file under \`${input.themesDirRelPath}/\`. Filename: \`<YYYY-MM-DD>-<kebab-slug>.md\`. Include a \`## Sources\` section listing ≥ 1 evidence path that resolves to \`_logs/${input.cycleId}/...\` or \`${input.cycleArchiveRelPath}\`.`,
    `7. **Done.** Stop. The orchestrator does not invoke you again.`,
    '',
    '## Constraints',
    '',
    '- Brain query MUST happen first. The bench gate fails otherwise.',
    '- Every theme MUST have resolvable evidence in `## Sources`. Vague observations get rejected.',
    '- If the cycle\'s event log contains any wedge or send-back event, ≥ 1 theme MUST carry `category: antipattern`.',
    '- Themes go under `brain/projects/<project>/themes/`, NOT `brain/forge/themes/`. Forge-wide lessons are rare and out of scope for this cycle.',
    '- One theme per file. Do not combine unrelated lessons.',
  ].join('\n');
}

/** Tool-use telemetry surfaced by both the bench and the live cycle. */
export type ReflectorToolUseSummary = {
  brainReads: number;
  themeWrites: number;
  retroWrites: number;
  bashCalls: number;
};

/**
 * Inspect a streamed assistant message and increment the summary in place.
 * - `brainReads`     — Read/Grep/Glob with a target containing `brain/`.
 * - `themeWrites`    — Write/Edit with a target containing `brain/projects/.../themes/` or `brain/_raw/`.
 * - `retroWrites`    — Write/Edit with a target ending in `retro.md`.
 * - `bashCalls`      — any Bash invocation.
 */
export function tallyToolUse(
  message: { content?: Array<{ type?: string; name?: string; input?: unknown }> } | undefined,
  summary: ReflectorToolUseSummary,
): void {
  const blocks = message?.content ?? [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;
    const name = block.name ?? '';
    const blob = JSON.stringify(block.input ?? {});
    if (name === 'Bash') {
      summary.bashCalls += 1;
      continue;
    }
    if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      if (blob.includes('brain/') || blob.includes('"brain"')) summary.brainReads += 1;
      continue;
    }
    if (name === 'Write' || name === 'Edit') {
      if (
        blob.includes('/themes/') ||
        blob.includes('brain/_raw/') ||
        blob.includes('brain\\_raw\\') ||
        blob.includes('brain/projects/')
      ) {
        summary.themeWrites += 1;
      }
      if (blob.includes('retro.md')) summary.retroWrites += 1;
    }
  }
}
