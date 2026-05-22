/**
 * LLM Council critic-chain runner.
 *
 * The architect skill delegates to architect-llm-council to run a draft
 * initiative through CEO/eng/design/DX critics. Each critic is invoked as an
 * SDK subagent; mechanical issues (`flags`) are auto-applied; taste decisions
 * (`escalations`) are aggregated and surfaced to the user.
 *
 * Per ADR 003 (skills-as-agents) and the architect-llm-council SKILL.md.
 *
 * The SDK's `query` is dependency-injectable (`queryFn`) so unit tests verify
 * the critic-chain plumbing without hitting the network.
 *
 * S2A robustness fix (I-23):
 *  - `maxTurns` default bumped to 60 (was 5).
 *  - On `result` with no `structured_output`, the runner retries ONCE with a
 *    tighter `messageFormat` asking the critic to repeat the verdict as a
 *    fenced ```json block, then parses that block.
 *  - On second failure, emits a `council.fallback-required` event with the
 *    raw last assistant text and returns a PARTIAL CouncilResult (the calling
 *    architect can decide whether to surface the fallback inline). The runner
 *    no longer throws on the empty-structured-output case.
 *  - New `maxDraftChars?: number` option (default 50_000) caps how much of
 *    the draft is fed into each critic; longer drafts are truncated and the
 *    critic is told they're seeing a slice.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

export type Critic = {
  /** Stable identifier — `ceo`, `eng`, etc. Used for de-duplicating escalations. */
  name: string;
  /** The system prompt for this critic perspective. */
  prompt: string;
  /** Model to use. `sonnet` is the default. */
  model: 'sonnet' | 'opus' | 'haiku';
};

export type Flag = {
  /** Stable identifier for the flag (e.g. `missing-rollback`). */
  id: string;
  description: string;
  /** Description of the auto-applied fix; the orchestrator/architect persists it. */
  appliedFix: string;
};

export type EscalationOption = {
  label: string;
  rationale: string;
};

export type Escalation = {
  /** Which critic raised this. */
  critic: string;
  question: string;
  options: EscalationOption[];
};

export type CriticVerdict = {
  flags: Flag[];
  escalations: Escalation[];
};

export type CouncilQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown>;

/** Lightweight event sink used to surface runner-level telemetry (fallbacks,
 *  retries) to the caller without polluting the structured result. */
export type CouncilEvent =
  | { type: 'council.start' }
  | { type: 'council.critic-start'; critic: string }
  | { type: 'council.critic-end'; critic: string; costUsd: number }
  | { type: 'council.retry-with-fenced-json'; critic: string }
  | { type: 'council.fallback-required'; critic: string; rawText: string }
  | { type: 'council.draft-truncated'; critic: string; fromChars: number; toChars: number }
  | { type: 'council.end'; totalCostUsd: number };

export type CouncilInput = {
  /** The draft initiative spec (markdown body — frontmatter handled separately). */
  draft: string;
  /** Critics to run, in order. */
  critics: Critic[];
  /** Project context to pass into every critic prompt. Optional but recommended. */
  projectContext?: string;
  /** Inject a fake `query` for testing. */
  queryFn?: CouncilQueryFn;
  /** Maximum chars of the draft fed to each critic. Default 50_000. */
  maxDraftChars?: number;
  /** Maximum turns per critic invocation. Default 60. */
  maxTurns?: number;
  /** Optional event sink — fired in order; throws are swallowed. */
  onEvent?: (event: CouncilEvent) => void;
};

export type CouncilResult = {
  flags: Flag[];
  escalations: Escalation[];
  totalCostUsd: number;
  /** Per-critic verdicts kept for audit / event log. */
  perCritic: { critic: string; verdict: CriticVerdict; costUsd: number }[];
  /** Critics that fell through to the fallback path. Empty on clean runs. */
  fallbackCritics: string[];
};

const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          appliedFix: { type: 'string' },
        },
        required: ['id', 'description', 'appliedFix'],
      },
    },
    escalations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          critic: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['label', 'rationale'],
            },
          },
        },
        required: ['critic', 'question', 'options'],
      },
    },
  },
  required: ['flags', 'escalations'],
};

const DEFAULT_MAX_DRAFT_CHARS = 50_000;
const DEFAULT_MAX_TURNS = 60;

export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
  const queryFn: CouncilQueryFn = input.queryFn ?? (sdkQuery as unknown as CouncilQueryFn);
  const maxDraftChars = input.maxDraftChars ?? DEFAULT_MAX_DRAFT_CHARS;
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const onEvent = input.onEvent ?? (() => undefined);
  const emit = (e: CouncilEvent): void => {
    try { onEvent(e); } catch { /* event sinks must not break the runner */ }
  };

  const flags: Flag[] = [];
  const escalations: Escalation[] = [];
  const perCritic: CouncilResult['perCritic'] = [];
  const fallbackCritics: string[] = [];
  let totalCostUsd = 0;
  const seen = new Set<string>();

  emit({ type: 'council.start' });

  for (const critic of input.critics) {
    emit({ type: 'council.critic-start', critic: critic.name });
    const draftSlice = sliceDraft(input.draft, maxDraftChars);
    if (draftSlice.truncated) {
      emit({
        type: 'council.draft-truncated',
        critic: critic.name,
        fromChars: input.draft.length,
        toChars: draftSlice.text.length,
      });
    }

    const { verdict, costUsd, fellBack, rawText } = await runOneCritic({
      critic,
      draft: draftSlice.text,
      truncatedNote: draftSlice.note,
      projectContext: input.projectContext,
      queryFn,
      maxTurns,
      emit,
    });

    if (fellBack) {
      emit({ type: 'council.fallback-required', critic: critic.name, rawText });
      fallbackCritics.push(critic.name);
    }

    totalCostUsd += costUsd;
    perCritic.push({ critic: critic.name, verdict, costUsd });
    flags.push(...verdict.flags);
    for (const e of verdict.escalations) {
      const key = `${e.critic}:${e.question}`;
      if (seen.has(key)) continue;
      seen.add(key);
      escalations.push(e);
    }
    emit({ type: 'council.critic-end', critic: critic.name, costUsd });
  }

  emit({ type: 'council.end', totalCostUsd });
  return { flags, escalations, totalCostUsd, perCritic, fallbackCritics };
}

// ---------------------------------------------------------------------------
// One critic, three states: structured success | fenced-json retry | fallback
// ---------------------------------------------------------------------------

type OneCriticOutcome = {
  verdict: CriticVerdict;
  costUsd: number;
  fellBack: boolean;
  rawText: string;
};

async function runOneCritic(args: {
  critic: Critic;
  draft: string;
  truncatedNote: string | null;
  projectContext?: string;
  queryFn: CouncilQueryFn;
  maxTurns: number;
  emit: (e: CouncilEvent) => void;
}): Promise<OneCriticOutcome> {
  const { critic, draft, truncatedNote, projectContext, queryFn, maxTurns, emit } = args;
  const prompt = renderCriticPrompt(critic, draft, projectContext, truncatedNote);

  // --- attempt 1: structured output via json_schema ---
  const r1 = await invokeCritic(queryFn, {
    prompt,
    systemPrompt: critic.prompt,
    model: critic.model,
    maxTurns,
    outputFormat: { type: 'json_schema', schema: STRUCTURED_OUTPUT_SCHEMA },
    criticName: critic.name,
  });

  if (r1.verdict) {
    return { verdict: r1.verdict, costUsd: r1.costUsd, fellBack: false, rawText: r1.rawText };
  }

  // --- attempt 2: tighter prompt asking for a fenced JSON block ---
  emit({ type: 'council.retry-with-fenced-json', critic: critic.name });
  const retryPrompt = [
    prompt,
    '',
    '---',
    '',
    'IMPORTANT: the previous attempt returned no structured output.',
    'Repeat your verdict NOW as a fenced JSON block matching this shape:',
    '',
    '```json',
    JSON.stringify({
      flags: [{ id: '<id>', description: '<desc>', appliedFix: '<fix>' }],
      escalations: [
        {
          critic: critic.name,
          question: '<question>',
          options: [{ label: '<label>', rationale: '<rationale>' }],
        },
      ],
    }, null, 2),
    '```',
    '',
    'Emit the JSON block and nothing else after it. If you have no flags or escalations, emit `{ "flags": [], "escalations": [] }`.',
  ].join('\n');

  const r2 = await invokeCritic(queryFn, {
    prompt: retryPrompt,
    systemPrompt: critic.prompt,
    model: critic.model,
    maxTurns,
    outputFormat: undefined, // free-text — we parse fenced JSON from the body
    criticName: critic.name,
  });

  const parsedFromFence = parseFencedJsonVerdict(r2.rawText);
  if (parsedFromFence) {
    return {
      verdict: parsedFromFence,
      costUsd: r1.costUsd + r2.costUsd,
      fellBack: false,
      rawText: r2.rawText,
    };
  }

  // --- attempt 3: fallback — return empty verdict + raw text for the caller ---
  return {
    verdict: { flags: [], escalations: [] },
    costUsd: r1.costUsd + r2.costUsd,
    fellBack: true,
    rawText: r2.rawText || r1.rawText,
  };
}

type InvokeResult = {
  verdict: CriticVerdict | null;
  costUsd: number;
  rawText: string;
};

async function invokeCritic(
  queryFn: CouncilQueryFn,
  params: {
    prompt: string;
    systemPrompt: string;
    model: 'sonnet' | 'opus' | 'haiku';
    maxTurns: number;
    outputFormat: { type: string; schema: unknown } | undefined;
    criticName: string;
  },
): Promise<InvokeResult> {
  const options: Record<string, unknown> = {
    systemPrompt: params.systemPrompt,
    model: params.model,
    maxTurns: params.maxTurns,
    permissionMode: 'plan',
    allowedTools: [],
    _criticName: params.criticName,
  };
  if (params.outputFormat) options.outputFormat = params.outputFormat;

  let verdict: CriticVerdict | null = null;
  let costUsd = 0;
  let rawText = '';
  for await (const msg of queryFn({ prompt: params.prompt, options })) {
    const m = msg as {
      type?: string;
      subtype?: string;
      structured_output?: unknown;
      total_cost_usd?: number;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (m.type === 'assistant') {
      // Accumulate assistant text so we can parse fenced JSON on retry.
      for (const block of m.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          rawText += (rawText ? '\n' : '') + block.text;
        }
      }
      continue;
    }
    if (m.type !== 'result') continue;
    if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
    if (m.structured_output && typeof m.structured_output === 'object') {
      verdict = m.structured_output as CriticVerdict;
    }
    break;
  }
  return { verdict, costUsd, rawText };
}

/** Pull the first ```json fenced block out of free-text and parse it as a CriticVerdict.
 *  Returns null if no block found or the parsed shape isn't a verdict. */
function parseFencedJsonVerdict(text: string): CriticVerdict | null {
  if (!text) return null;
  const fence = /```json\s*([\s\S]*?)```/i;
  const m = fence.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as Partial<CriticVerdict>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      flags: Array.isArray(parsed.flags) ? (parsed.flags as Flag[]) : [],
      escalations: Array.isArray(parsed.escalations) ? (parsed.escalations as Escalation[]) : [],
    };
  } catch {
    return null;
  }
}

function sliceDraft(draft: string, maxDraftChars: number): { text: string; truncated: boolean; note: string | null } {
  if (draft.length <= maxDraftChars) {
    return { text: draft, truncated: false, note: null };
  }
  return {
    text: draft.slice(0, maxDraftChars),
    truncated: true,
    note: `[draft was truncated for this critic from ${draft.length} chars to ${maxDraftChars} chars; later sections were elided]`,
  };
}

function renderCriticPrompt(
  critic: Critic,
  draft: string,
  projectContext: string | undefined,
  truncatedNote: string | null,
): string {
  return [
    `You are the **${critic.name}** critic on the architect's LLM Council.`,
    '',
    'Your job: review the draft initiative below and emit a structured verdict.',
    '',
    '- `flags`: mechanical issues you can auto-resolve. For each, supply an `id`, a short `description`, and the `appliedFix` (a one-line description of the fix you would apply).',
    '- `escalations`: taste decisions only the user can make. For each, supply `critic` (your name), the `question`, and 2-4 `options` each with a `label` and `rationale`.',
    '',
    'Do not invent new requirements. Improve what is there; do not expand scope.',
    '',
    projectContext ? `## Project context\n\n${projectContext}\n` : '',
    truncatedNote ? `> ${truncatedNote}\n` : '',
    '## Draft initiative',
    '',
    draft,
  ].filter((s) => s !== '').join('\n');
}

export function defaultCritics(): Critic[] {
  return [
    {
      name: 'ceo',
      model: 'sonnet',
      prompt: [
        'You are the CEO critic. Evaluate strategic alignment.',
        '- Does this initiative align with the project\'s stated direction?',
        '- Is the value proposition clear?',
        '- Is it the most leveraged thing right now, or should something else come first?',
        '- Is the scope releasable as a coherent unit, or is it really two initiatives?',
      ].join('\n'),
    },
    {
      name: 'eng',
      model: 'sonnet',
      prompt: [
        'You are the engineering critic. Evaluate technical clarity.',
        '- Are dependencies between features explicit (depends_on) and acyclic?',
        '- Are acceptance criteria verifiable (Given-When-Then) by the orchestrator (npm test, gh pr checks), not just claimed by the agent?',
        '- Is each work item atomic enough for the developer loop (≤3 files where possible)?',
        '- Is the rollback path stated for changes that touch persistent state?',
      ].join('\n'),
    },
    {
      name: 'design',
      model: 'sonnet',
      prompt: [
        'You are the design critic. Evaluate user experience.',
        '- For user-facing initiatives: is the experience considered (states, edge cases, accessibility)?',
        '- For non-UI initiatives: skip with no flags or escalations.',
        '- Is there an information-architecture impact downstream of this initiative?',
      ].join('\n'),
    },
    {
      name: 'dx',
      model: 'sonnet',
      prompt: [
        'You are the developer-experience critic. Evaluate maintainability.',
        '- Does this make the project easier or harder to work on next month?',
        '- Are migrations / deprecations handled? (e.g. removing an API: is there a deprecation window?)',
        '- Does this introduce a new dependency, framework, or build step? If so, is the cost justified vs the alternative?',
        '- Is there a runbook / documentation update implied that has not been called out?',
      ].join('\n'),
    },
  ];
}
