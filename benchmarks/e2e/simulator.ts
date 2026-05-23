/**
 * Human-simulator agent for the e2e bench. Acts as the "human in the loop"
 * for review-Ralph stage 2: takes the verdict context + a target spec +
 * orchestrator-pre-computed spec results, returns approve | send-back.
 *
 * Spec-driven verdict: approves iff every spec check passed AND the PR
 * description is honest about what changed. Sends back with 1-3 specific
 * Given-When-Then criteria when one or more checks failed (or the agent
 * shipped a PR that misrepresents the diff).
 *
 * Tool whitelist: Read only — the simulator inspects the diff, demo source,
 * PR description, work items. Never runs commands itself; the bench harness
 * pre-runs every spec check and feeds results in. This mirrors the
 * orchestrator-verified-gates pattern: the simulator's verdict is grounded
 * in ground truth, not its own claim.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import type {
  AcceptanceCriterion,
  WorkItem,
} from '../../orchestrator/work-item.ts';
import type {
  Verdict,
  VerdictContext,
} from '../../orchestrator/file-verdict.ts';

export type SimulatorQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type TargetSpec = {
  /** Argv-style command run by the bench to verify functional ACs (manifest-level). */
  manifest_ac_command: string[];
  /** Additional non-functional checks (each command exits 0 iff satisfied). */
  non_functional_checks: Array<{
    description: string;
    command: string[];
  }>;
  /** Strings the PR description must contain (substring match, case-insensitive). */
  required_pr_signals: string[];
};

export type PreComputedSpecResults = {
  manifest_acs_pass: boolean;
  non_functional_results: Array<{ description: string; passed: boolean }>;
  pr_signals_present: Record<string, boolean>;
};

export type SimulatorInput = {
  ctx: VerdictContext;
  spec: TargetSpec;
  /**
   * Bench harness pre-runs the spec checks orchestrator-side and feeds
   * results in. The simulator NEVER runs commands itself — its job is the
   * verdict, not the verification.
   */
  preComputedSpecResults: PreComputedSpecResults;
  /** Inject a fake `query` for testing. */
  queryFn?: SimulatorQueryFn;
  /** Override the SDK model. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Override max turns. Defaults to 10 — the simulator has nothing to do but read + decide. */
  maxTurns?: number;
};

const SIMULATOR_MODEL_DEFAULT = 'claude-sonnet-4-6';
const SIMULATOR_MAX_TURNS_DEFAULT = 10;

const SYSTEM_PROMPT = `You are a senior code reviewer evaluating whether a pull request meets a target spec.

Your job:
1. Read the PR description, the demo source script, the diff summary, and the
   work-item acceptance criteria.
2. Decide: APPROVE or SEND-BACK.
3. Output a single fenced \`\`\`json block with your verdict.

Approval criteria (ALL must be true to APPROVE):
- Every entry in \`spec_results.non_functional_results\` is \`passed: true\`.
- \`spec_results.manifest_acs_pass\` is true.
- Every entry in \`spec_results.pr_signals_present\` is true.
- The PR description's "What" section honestly describes what the diff does.

If APPROVE, output exactly:
\`\`\`json
{
  "kind": "approve",
  "rationale": "<1-2 sentence justification — what convinced you>"
}
\`\`\`

If any check failed, SEND-BACK. Output 1 to 3 specific Given-When-Then
criteria the developer must satisfy on the next pass — be precise about file
paths, command outputs, or assertion text. Mirror the WI's existing AC shape.

\`\`\`json
{
  "kind": "send-back",
  "rationale": "<1-2 sentence summary of what needs to change>",
  "feedback": [
    { "given": "...", "when": "...", "then": "..." },
    ...
  ]
}
\`\`\`

You ONLY output the JSON block. No prose before or after.

Tools: you have Read only. Read whatever you need from the worktree to
ground your verdict. You DO NOT run commands — the bench has already done
that and the results are in the prompt.
`;

export async function simulatorVerdict(input: SimulatorInput): Promise<Verdict> {
  const { ctx, spec, preComputedSpecResults } = input;
  const queryFn = input.queryFn ?? (sdkQuery as unknown as SimulatorQueryFn);

  const userPrompt = renderUserPrompt(ctx, spec, preComputedSpecResults);

  const options: Record<string, unknown> = {
    cwd: ctx.worktreePath,
    systemPrompt: SYSTEM_PROMPT,
    model: input.model ?? SIMULATOR_MODEL_DEFAULT,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
    maxTurns: input.maxTurns ?? SIMULATOR_MAX_TURNS_DEFAULT,
  };

  let assistantText = '';
  for await (const msg of queryFn({ prompt: userPrompt, options })) {
    const m = msg as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (m.type === 'assistant') {
      const content = m.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          assistantText += block.text;
        }
      }
    }
    if (m.type === 'result') break;
  }

  return parseVerdict(assistantText);
}

function renderUserPrompt(
  ctx: VerdictContext,
  spec: TargetSpec,
  results: PreComputedSpecResults,
): string {
  const prDescriptionContent = readSafe(ctx.prDescriptionPath);
  const wiSummary = ctx.workItems
    .map((wi) => formatWorkItemForPrompt(wi))
    .join('\n\n---\n\n');

  return [
    `# Review verdict — round ${ctx.roundNumber}`,
    '',
    `Initiative: **${ctx.initiativeId}**`,
    `Worktree: \`${ctx.worktreePath}\``,
    '',
    '## Pre-computed spec check results (orchestrator-verified)',
    '',
    `- manifest_acs_pass: **${results.manifest_acs_pass}**`,
    '',
    'Non-functional checks:',
    ...results.non_functional_results.map(
      (r) => `- [${r.passed ? 'x' : ' '}] ${r.description}`,
    ),
    '',
    'PR description signals (case-insensitive substring match):',
    ...Object.entries(results.pr_signals_present).map(
      ([sig, present]) => `- [${present ? 'x' : ' '}] "${sig}"`,
    ),
    '',
    '## Diff summary',
    '',
    '```',
    ctx.diffSummary,
    '```',
    '',
    '## Work items being reviewed',
    '',
    wiSummary,
    '',
    '## PR description (`<worktree>/.forge/pr-description.md`)',
    '',
    '```markdown',
    prDescriptionContent.length > 6000
      ? `${prDescriptionContent.slice(0, 6000)}\n... (truncated)`
      : prDescriptionContent,
    '```',
    '',
    '## Demo source',
    '',
    `Demo bundle directory: \`${ctx.demoBundleDir}\``,
    'Read the source script (`source.tape` or `source.spec.ts`) inside that directory and decide whether the demo authentically exercises the work-item acceptance criteria + any send-back ACs from prior rounds.',
    '',
    '## Decide',
    '',
    "Output a single fenced \\`\\`\\`json block — `approve` if every check above passed AND the PR description is honest; `send-back` otherwise. No prose outside the block.",
    '',
    'Reference target-spec for context (you already have the pre-computed results above):',
    '',
    `- manifest_ac_command: \`${spec.manifest_ac_command.join(' ')}\``,
    `- ${spec.non_functional_checks.length} non-functional checks`,
    `- ${spec.required_pr_signals.length} required PR signals: ${spec.required_pr_signals.map((s) => `"${s}"`).join(', ')}`,
  ].join('\n');
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '_(file not found)_';
  }
}

function formatWorkItemForPrompt(wi: WorkItem): string {
  const acs = wi.acceptance_criteria
    .map(
      (ac, i) =>
        `  ${i + 1}. GIVEN ${ac.given.trim()} WHEN ${ac.when.trim()} THEN ${ac.then.trim()}`,
    )
    .join('\n');
  return [
    `**${wi.work_item_id}** (${wi.status})`,
    `Files in scope: ${wi.files_in_scope.map((f) => `\`${f}\``).join(', ') || '_none_'}`,
    'Acceptance criteria:',
    acs,
  ].join('\n');
}

/**
 * Extract a verdict from the assistant's text. Tolerant of leading/trailing
 * prose around the JSON block (the prompt asks for none, but be defensive).
 * Throws when no parseable JSON is found or the structure is wrong.
 */
export function parseVerdict(text: string): Verdict {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const body = fenced ? fenced[1] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `simulator output not valid JSON: ${err instanceof Error ? err.message : String(err)} — got: ${text.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`simulator output is not a JSON object: ${typeof parsed}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'approve') {
    return {
      kind: 'approve',
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    };
  }
  if (obj.kind === 'send-back') {
    const rawFeedback = Array.isArray(obj.feedback) ? obj.feedback : [];
    const feedback: AcceptanceCriterion[] = [];
    for (const item of rawFeedback) {
      if (typeof item !== 'object' || item === null) continue;
      const f = item as Record<string, unknown>;
      if (
        typeof f.given === 'string' &&
        typeof f.when === 'string' &&
        typeof f.then === 'string' &&
        f.given.trim() !== '' &&
        f.when.trim() !== '' &&
        f.then.trim() !== ''
      ) {
        feedback.push({ given: f.given.trim(), when: f.when.trim(), then: f.then.trim() });
      }
    }
    if (feedback.length === 0) {
      throw new Error('simulator send-back verdict has no valid feedback ACs');
    }
    return {
      kind: 'send-back',
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      feedback,
    };
  }
  throw new Error(`simulator output has unknown kind: ${String(obj.kind)}`);
}

/**
 * Run every spec check orchestrator-side. Returns the structured results the
 * simulator's prompt is grounded in.
 */
export function runSpecChecks(worktreePath: string, spec: TargetSpec): PreComputedSpecResults {
  const manifestAcs = runCmd(worktreePath, spec.manifest_ac_command);
  const nonFunctional = spec.non_functional_checks.map((check) => ({
    description: check.description,
    passed: runCmd(worktreePath, check.command),
  }));
  const prDescriptionPath = resolve(worktreePath, '.forge', 'pr-description.md');
  let prBody = '';
  try {
    prBody = readFileSync(prDescriptionPath, 'utf8');
  } catch {
    /* missing pr-description → all signals false */
  }
  const prSignals: Record<string, boolean> = {};
  const haystack = prBody.toLowerCase();
  for (const sig of spec.required_pr_signals) {
    prSignals[sig] = haystack.includes(sig.toLowerCase());
  }
  return {
    manifest_acs_pass: manifestAcs,
    non_functional_results: nonFunctional,
    pr_signals_present: prSignals,
  };
}

function runCmd(cwd: string, cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
