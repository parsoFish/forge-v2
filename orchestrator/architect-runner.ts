/**
 * In-UI architect runner (ADR 020).
 *
 * The architect used to be an interactive Claude-Code skill the operator ran in
 * their own terminal session (`/forge-architect`), driving `AskUserQuestion`.
 * ADR 020 moves it into the forge UI as a server-side, operator-driven,
 * file-checkpointed runner. This module is that runner's brain: a bounded,
 * Ralph-style **turn** that reads the session-dir state, advances ONE step via a
 * `status.json` cursor, and exits. Operator think-time happens *between* turns
 * (the bridge re-spawns a turn on each operator action), so there is no
 * long-lived blocked session and the flow is crash-resumable (ADR 012).
 *
 * Interactivity is **file-based handoff** — the same pattern the reflector uses
 * (`questions.json` ↔ `answers.json`), NOT SDK `canUseTool` interception (which
 * is an allow/deny permission gate and cannot return the operator's answer as a
 * tool result). See ADR 020 for the full rationale.
 *
 * The LLM call sits behind an injectable `queryFn` seam (the `runCouncil`
 * pattern) so every turn is unit-testable without a live LLM. The prompt is
 * composed from `skills/architect/SKILL.md` (not re-baked in TS) so prompt
 * changes stay content changes — ADR 003 is preserved.
 *
 * State machine (`status.json.phase`):
 *
 *   interviewing ──(needs input)──▶ awaiting-answers ──(bridge: answer)──▶ interviewing
 *        │ (ready to draft)
 *        ▼
 *     drafting ──▶ awaiting-verdict ──(bridge: approve)──▶ finalizing ──▶ committed
 *                        │ (bridge: revise) ──▶ interviewing
 *                        └ (bridge: reject)  ──▶ rejected
 *
 * `awaiting-answers` / `awaiting-verdict` are bridge-owned waiting states — the
 * runner is only spawned in an *actionable* phase. The bridge transitions out of
 * the waiting states when the operator acts, then re-spawns a turn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  runCouncil,
  defaultCritics,
  type CouncilQueryFn,
  type Escalation,
} from '../skills/architect-llm-council/council.ts';

export type { CouncilQueryFn } from '../skills/architect-llm-council/council.ts';
import {
  writePlanDoc,
  sessionPaths,
  type ArchitectSession,
  type ProposedInitiative,
  type ProposedFeature,
  type CouncilTranscript,
  type InterviewRound,
} from '../cli/architect-plan.ts';
import {
  serializeManifest,
  type InitiativeManifest,
  type Feature,
} from './manifest.ts';
import { promoteManifests } from './promote-manifests.ts';
import { createLogger, type EventLogger } from './logging.ts';

// ---------------------------------------------------------------------------
// Session-dir state contract
// ---------------------------------------------------------------------------

export type ArchitectPhase =
  | 'interviewing'
  | 'awaiting-answers'
  | 'drafting'
  | 'awaiting-verdict'
  | 'finalizing'
  | 'committed'
  | 'rejected';

export type ArchitectStatus = {
  session_id: string;
  project: string;
  project_repo_path: string;
  phase: ArchitectPhase;
  /** 1-based interview round counter. */
  round: number;
  /** The operator's raw idea (also persisted to `idea.md`). */
  idea: string;
  updated_at: string;
};

/** One operator-facing question — the reflector's `StructuredQuestion` shape so
 *  the UI form renderer is shared. */
export type ArchitectQuestion = {
  question: string;
  /** ≤12 chars chip label (AskUserQuestion constraint). */
  header: string;
  options: { label: string; description: string }[];
};

/** One round of answers POSTed by the operator (written by the bridge). */
export type AnswerRound = {
  round: number;
  answers: { question: string; answer: string }[];
};

// ---------------------------------------------------------------------------
// Runner I/O
// ---------------------------------------------------------------------------

export type RunArchitectTurnInput = {
  sessionId: string;
  projectRoot: string;
  /** Inject a fake `query` for tests. Defaults to the SDK. */
  queryFn?: CouncilQueryFn;
  /** Separate seam for council calls; defaults to `queryFn`. */
  councilQueryFn?: CouncilQueryFn;
  /** `_logs/` root; defaults to `<cwd>/_logs`. */
  logsRoot?: string;
  /** `_queue/` root; defaults to `<cwd>/_queue`. */
  queueRoot?: string;
  /** Logger override (tests). */
  logger?: EventLogger;
  /** Path to the architect skill (prompt source — ADR 003). */
  skillPromptPath?: string;
  /** Safety cap on interview rounds before forcing a draft. Default 4. */
  maxInterviewRounds?: number;
};

export type RunArchitectTurnResult = {
  /** Phase the session is in AFTER this turn. */
  phase: ArchitectPhase;
  /** Files written this turn. */
  wrote: string[];
  /** Present when the turn ended needing operator answers. */
  questions?: ArchitectQuestion[];
  /** Present when the turn produced a plan. */
  planPath?: string;
  /** Present when the turn finalized (manifests promoted to the queue). */
  promotedManifestPaths?: string[];
};

const DEFAULT_MAX_INTERVIEW_ROUNDS = 4;

// ---------------------------------------------------------------------------
// Turn entry point
// ---------------------------------------------------------------------------

export async function runArchitectTurn(
  input: RunArchitectTurnInput,
): Promise<RunArchitectTurnResult> {
  const paths = sessionPaths(input.projectRoot, input.sessionId);
  const status = readStatus(paths.sessionDir);
  if (!status) {
    throw new Error(
      `architect runner: no status.json at ${paths.sessionDir}. Has the session been started?`,
    );
  }

  const logger =
    input.logger ??
    createLogger(`_architect-${input.sessionId}`, input.logsRoot ?? resolve('_logs'));
  const queryFn: CouncilQueryFn = input.queryFn ?? (sdkQuery as unknown as CouncilQueryFn);
  const councilQueryFn = input.councilQueryFn ?? queryFn;
  const maxRounds = input.maxInterviewRounds ?? DEFAULT_MAX_INTERVIEW_ROUNDS;

  logger.emit({
    initiative_id: `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-runner',
    event_type: 'start',
    input_refs: [join(paths.sessionDir, 'status.json')],
    output_refs: [],
    message: `architect turn (phase=${status.phase}, round=${status.round})`,
    metadata: { session_id: input.sessionId, phase: status.phase, round: status.round },
  });

  // Interview phase — may flow straight through to drafting when ready.
  let phase = status.phase;
  if (phase === 'interviewing') {
    const interview = readInterview(paths.sessionDir);
    const decision = await runInterviewStep({
      status,
      interview,
      queryFn,
      skillPromptPath: input.skillPromptPath,
    });
    if (!decision.done && status.round < maxRounds && decision.questions.length > 0) {
      const questionsPath = writeQuestions(paths.sessionDir, decision.questions);
      writeStatus(paths.sessionDir, { ...status, phase: 'awaiting-answers' });
      logger.emit({
        initiative_id: `architect-session-${input.sessionId}`,
        phase: 'architect',
        skill: 'architect-runner',
        event_type: 'log',
        input_refs: [],
        output_refs: [questionsPath],
        message: `interview round ${status.round} — ${decision.questions.length} question(s) for the operator`,
        metadata: { session_id: input.sessionId, round: status.round },
      });
      return { phase: 'awaiting-answers', wrote: [questionsPath], questions: decision.questions };
    }
    // Ready to draft (operator answered enough, or the round cap forced it).
    phase = 'drafting';
    writeStatus(paths.sessionDir, { ...status, phase: 'drafting' });
  }

  if (phase === 'drafting') {
    const result = await runDraftStep({
      input,
      paths,
      status,
      queryFn,
      councilQueryFn,
      logger,
      resolvedDecisions: null,
    });
    return result;
  }

  if (phase === 'finalizing') {
    const result = await runFinalizeStep({ input, paths, status, queryFn, councilQueryFn, logger });
    return result;
  }

  // No actionable work in a waiting/terminal phase — return the phase unchanged.
  return { phase, wrote: [] };
}

// ---------------------------------------------------------------------------
// Interview step
// ---------------------------------------------------------------------------

type InterviewDecision = { done: boolean; questions: ArchitectQuestion[] };

const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          header: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label', 'description'],
            },
          },
        },
        required: ['question', 'header', 'options'],
      },
    },
  },
  required: ['done'],
};

async function runInterviewStep(args: {
  status: ArchitectStatus;
  interview: InterviewRound[];
  queryFn: CouncilQueryFn;
  skillPromptPath?: string;
}): Promise<InterviewDecision> {
  const { status, interview, queryFn, skillPromptPath } = args;
  const skill = loadSkillPrompt(skillPromptPath);
  const priorQa = interview.length
    ? interview.map((r, i) => `${i + 1}. Q: ${r.question}\n   A: ${r.answer}`).join('\n')
    : '_(no answers yet — this is the first round)_';
  const prompt = [
    skill,
    '',
    '## Your task this turn: the interview step',
    '',
    `Project: ${status.project}`,
    '',
    'Operator idea / brief:',
    status.idea,
    '',
    'Interview so far:',
    priorQa,
    '',
    'Decide whether you have enough to draft a coherent, releasable initiative ' +
      'WITHOUT unresolved scope / success-signal / constraint ambiguity. ' +
      'If you do, return `{ "done": true }`. Otherwise return `{ "done": false, ' +
      '"questions": [...] }` with 1-4 high-leverage questions in the ' +
      'AskUserQuestion shape (question, header ≤12 chars, 2-4 options each with ' +
      'label + description). Ask only what unblocks drafting; stop as soon as ' +
      'further questions would merely refine.',
  ].join('\n');

  const out = await runStructured<{ done?: boolean; questions?: ArchitectQuestion[] }>({
    queryFn,
    prompt,
    schema: INTERVIEW_SCHEMA,
  });
  const questions = Array.isArray(out?.questions) ? out!.questions! : [];
  return { done: out?.done === true, questions };
}

// ---------------------------------------------------------------------------
// Draft step (+ council + PLAN)
// ---------------------------------------------------------------------------

type DraftInitiative = {
  slug: string;
  title: string;
  iteration_budget: number;
  cost_budget_usd: number;
  features: { title: string; depends_on?: number[] }[];
  body: string;
};

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    vision: { type: 'string' },
    initiatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          title: { type: 'string' },
          iteration_budget: { type: 'number' },
          cost_budget_usd: { type: 'number' },
          features: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                depends_on: { type: 'array', items: { type: 'number' } },
              },
              required: ['title'],
            },
          },
          body: { type: 'string' },
        },
        required: ['slug', 'title', 'iteration_budget', 'cost_budget_usd', 'features', 'body'],
      },
    },
  },
  required: ['vision', 'initiatives'],
};

async function runDraftStep(args: {
  input: RunArchitectTurnInput;
  paths: ReturnType<typeof sessionPaths>;
  status: ArchitectStatus;
  queryFn: CouncilQueryFn;
  councilQueryFn: CouncilQueryFn;
  logger: EventLogger;
  resolvedDecisions: string | null;
}): Promise<RunArchitectTurnResult> {
  const { input, paths, status, queryFn, councilQueryFn, logger, resolvedDecisions } = args;
  const interview = readInterview(paths.sessionDir);
  const skill = loadSkillPrompt(input.skillPromptPath);

  const prompt = [
    skill,
    '',
    '## Your task this turn: draft the initiative(s)',
    '',
    `Project: ${status.project}`,
    '',
    'Operator idea / brief:',
    status.idea,
    '',
    'Interview answers:',
    interview.length
      ? interview.map((r, i) => `${i + 1}. Q: ${r.question}\n   A: ${r.answer}`).join('\n')
      : '_(operator drafted directly)_',
    ...(resolvedDecisions
      ? ['', 'Resolved design decisions (bake these into the manifests):', resolvedDecisions]
      : []),
    '',
    'Produce one or more coherent, releasable initiatives. For each: a kebab ' +
      '`slug`, a `title`, an `iteration_budget` (>0) and `cost_budget_usd` (>0), ' +
      'a `features` list (each with a title and optional `depends_on` referencing ' +
      'earlier feature indices), and a markdown `body` spec with concrete, ' +
      'Given-When-Then acceptance criteria. Dependencies must be explicit.',
  ].join('\n');

  const draft = await runStructured<{ vision?: string; initiatives?: DraftInitiative[] }>({
    queryFn,
    prompt,
    schema: DRAFT_SCHEMA,
  });
  const vision = (draft?.vision ?? status.idea).trim();
  const draftInitiatives = Array.isArray(draft?.initiatives) ? draft!.initiatives! : [];
  if (draftInitiatives.length === 0) {
    throw new Error('architect runner: draft step returned no initiatives');
  }

  const created_at = new Date().toISOString();
  const datePart = created_at.slice(0, 10);
  const manifests = draftInitiatives.map((d) => buildManifest(d, status, datePart, created_at));

  // Council reviews the combined draft body (existing helper, unchanged).
  const combinedBody = manifests.map((m) => m.body).join('\n\n---\n\n');
  const council = await runCouncil({
    draft: combinedBody,
    critics: defaultCritics(),
    projectContext: `Project: ${status.project}\nVision: ${vision}`,
    queryFn: councilQueryFn,
  });
  const councilTranscript: CouncilTranscript = {
    flags: council.flags,
    escalations: council.escalations,
    perCritic: council.perCritic,
    totalCostUsd: council.totalCostUsd,
  };

  // Write draft manifests (promoted to the queue only on finalize/approve).
  if (!existsSync(paths.manifestsDir)) mkdirSync(paths.manifestsDir, { recursive: true });
  for (const m of manifests) {
    writeFileSync(join(paths.manifestsDir, `${m.initiative_id}.md`), serializeManifest(m));
  }

  const proposed: ProposedInitiative[] = manifests.map((m) => ({
    initiative_id: m.initiative_id,
    project: m.project,
    project_repo_path: m.project_repo_path,
    title: m.features[0]?.title ?? m.initiative_id,
    iteration_budget: m.iteration_budget,
    cost_budget_usd: m.cost_budget_usd,
    features: m.features.map<ProposedFeature>((f) => ({
      feature_id: f.feature_id,
      title: f.title,
      depends_on: f.depends_on,
    })),
    body: m.body,
  }));

  const session: ArchitectSession = {
    session_id: status.session_id,
    project: status.project,
    project_repo_path: status.project_repo_path,
    vision,
    interview,
    brain_context: [],
    council: councilTranscript,
    initiatives: proposed,
    open_escalations: council.escalations,
  };

  const planPath = writePlanDoc(session, input.projectRoot);
  // Persist the escalation set keyed for the gate (esc-<index>).
  writeFileSync(
    join(paths.sessionDir, 'escalations.json'),
    JSON.stringify(keyEscalations(council.escalations), null, 2),
  );
  writeStatus(paths.sessionDir, { ...status, phase: 'awaiting-verdict' });

  logger.emit({
    initiative_id: `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-runner',
    event_type: 'log',
    input_refs: [],
    output_refs: [planPath],
    message: `plan-emitted (${manifests.length} initiative(s), ${council.escalations.length} escalation(s))`,
    metadata: {
      session_id: input.sessionId,
      initiative_ids: manifests.map((m) => m.initiative_id),
      escalation_count: council.escalations.length,
    },
  });

  return { phase: 'awaiting-verdict', wrote: [planPath], planPath };
}

// ---------------------------------------------------------------------------
// Finalize step (approve → bake resolved decisions → promote to queue)
// ---------------------------------------------------------------------------

async function runFinalizeStep(args: {
  input: RunArchitectTurnInput;
  paths: ReturnType<typeof sessionPaths>;
  status: ArchitectStatus;
  queryFn: CouncilQueryFn;
  councilQueryFn: CouncilQueryFn;
  logger: EventLogger;
}): Promise<RunArchitectTurnResult> {
  const { input, paths, status, logger } = args;
  const resolved = readResolvedDecisions(paths.sessionDir);

  // Regenerate manifests with the resolved decisions baked in, then promote.
  const draftResult = await runDraftStep({ ...args, resolvedDecisions: resolved });
  // runDraftStep leaves phase=awaiting-verdict; finalize promotes + advances.
  const queueRoot = input.queueRoot ?? resolve('_queue');
  const { writtenManifestPaths, writtenInitiativeIds } = promoteManifests(paths.manifestsDir, {
    queueRoot,
  });
  writeStatus(paths.sessionDir, { ...status, phase: 'committed' });

  logger.emit({
    initiative_id: writtenInitiativeIds[0] ?? `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-runner',
    event_type: 'log',
    input_refs: [paths.planPath],
    output_refs: writtenManifestPaths,
    message: 'plan-approved',
    metadata: {
      session_id: input.sessionId,
      action: 'plan-approved',
      initiative_ids: writtenInitiativeIds,
    },
  });

  return {
    phase: 'committed',
    wrote: writtenManifestPaths,
    planPath: draftResult.planPath,
    promotedManifestPaths: writtenManifestPaths,
  };
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

function buildManifest(
  d: DraftInitiative,
  status: ArchitectStatus,
  datePart: string,
  created_at: string,
): InitiativeManifest {
  const slug = slugify(d.slug || d.title);
  const features: Feature[] = (d.features.length ? d.features : [{ title: d.title }]).map(
    (f, i) => ({
      feature_id: `FEAT-${i + 1}`,
      title: f.title,
      depends_on: (f.depends_on ?? [])
        .filter((n) => Number.isInteger(n) && n >= 0 && n < d.features.length && n !== i)
        .map((n) => `FEAT-${n + 1}`),
    }),
  );
  return {
    initiative_id: `INIT-${datePart}-${slug}`,
    project: status.project,
    project_repo_path: status.project_repo_path,
    created_at,
    iteration_budget: d.iteration_budget > 0 ? Math.round(d.iteration_budget) : 5,
    cost_budget_usd: d.cost_budget_usd > 0 ? d.cost_budget_usd : 5,
    phase: 'pending',
    origin: 'architect',
    features,
    body: d.body,
  };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'initiative'
  );
}

// ---------------------------------------------------------------------------
// Escalation keying — stable ids the PLAN gate selects against
// ---------------------------------------------------------------------------

export type KeyedEscalation = Escalation & { id: string };

export function keyEscalations(escalations: Escalation[]): KeyedEscalation[] {
  return escalations.map((e, i) => ({ ...e, id: `esc-${i}` }));
}

// ---------------------------------------------------------------------------
// Structured-output query (mirrors council's parse path)
// ---------------------------------------------------------------------------

async function runStructured<T>(args: {
  queryFn: CouncilQueryFn;
  prompt: string;
  schema: unknown;
}): Promise<T | null> {
  const options: Record<string, unknown> = {
    permissionMode: 'plan',
    allowedTools: [],
    outputFormat: args.schema,
    maxTurns: 30,
  };
  let structured: T | null = null;
  let rawText = '';
  for await (const msg of args.queryFn({ prompt: args.prompt, options })) {
    const m = msg as {
      type?: string;
      structured_output?: unknown;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          rawText += (rawText ? '\n' : '') + block.text;
        }
      }
      continue;
    }
    if (m.type !== 'result') continue;
    if (m.structured_output && typeof m.structured_output === 'object') {
      structured = m.structured_output as T;
    }
    break;
  }
  if (structured) return structured;
  // Fallback: parse a fenced ```json block from assistant text.
  return parseFencedJson<T>(rawText);
}

function parseFencedJson<T>(text: string): T | null {
  if (!text) return null;
  const m = /```json\s*([\s\S]*?)```/i.exec(text);
  const raw = m ? m[1] : text;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt source (ADR 003 — prompt is skill content, not re-baked TS)
// ---------------------------------------------------------------------------

let cachedSkill: string | null = null;
function loadSkillPrompt(skillPromptPath?: string): string {
  if (skillPromptPath) {
    try {
      return readFileSync(skillPromptPath, 'utf8');
    } catch {
      /* fall through to default */
    }
  }
  if (cachedSkill !== null) return cachedSkill;
  const def = resolve('skills/architect/SKILL.md');
  cachedSkill = existsSync(def) ? readFileSync(def, 'utf8') : 'You are the forge architect.';
  return cachedSkill;
}

// ---------------------------------------------------------------------------
// Session-dir file helpers
// ---------------------------------------------------------------------------

export function readStatus(sessionDir: string): ArchitectStatus | null {
  const p = join(sessionDir, 'status.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ArchitectStatus;
  } catch {
    return null;
  }
}

export function writeStatus(sessionDir: string, status: ArchitectStatus): string {
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  const p = join(sessionDir, 'status.json');
  writeFileSync(p, JSON.stringify({ ...status, updated_at: new Date().toISOString() }, null, 2));
  return p;
}

function writeQuestions(sessionDir: string, questions: ArchitectQuestion[]): string {
  const p = join(sessionDir, 'questions.json');
  writeFileSync(p, JSON.stringify(questions, null, 2));
  return p;
}

/** Read every `answers.json` round into a flat `InterviewRound[]`. The bridge
 *  appends rounds; this flattens them into the `ArchitectSession.interview`
 *  shape the renderer expects. */
export function readInterview(sessionDir: string): InterviewRound[] {
  const p = join(sessionDir, 'answers.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as AnswerRound[] | AnswerRound;
    const rounds = Array.isArray(parsed) ? parsed : [parsed];
    const out: InterviewRound[] = [];
    for (const r of rounds) {
      for (const a of r.answers ?? []) {
        out.push({ question: a.question, answer: a.answer });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Read `selections.json` + `feedback.md` into a markdown block the draft step
 *  bakes into the regenerated manifests. */
function readResolvedDecisions(sessionDir: string): string | null {
  const parts: string[] = [];
  const selPath = join(sessionDir, 'selections.json');
  if (existsSync(selPath)) {
    try {
      const sel = JSON.parse(readFileSync(selPath, 'utf8')) as Record<string, string>;
      const escPath = join(sessionDir, 'escalations.json');
      const escalations: KeyedEscalation[] = existsSync(escPath)
        ? (JSON.parse(readFileSync(escPath, 'utf8')) as KeyedEscalation[])
        : [];
      for (const [id, label] of Object.entries(sel)) {
        const esc = escalations.find((e) => e.id === id);
        parts.push(`- ${esc ? esc.question : id}: **${label}**`);
      }
    } catch {
      /* ignore malformed selections */
    }
  }
  const fbPath = join(sessionDir, 'feedback.md');
  if (existsSync(fbPath)) {
    const fb = readFileSync(fbPath, 'utf8').trim();
    if (fb) parts.push('', fb);
  }
  return parts.length ? parts.join('\n') : null;
}

/** Discover every architect session under `projects/<name>/_architect/<sid>/`
 *  — used by the bridge's `GET /api/architect/sessions`. Best-effort; never
 *  throws on a malformed dir. */
export function listArchitectSessions(projectsRoot: string): ArchitectStatus[] {
  const out: ArchitectStatus[] = [];
  if (!existsSync(projectsRoot)) return out;
  for (const project of safeReaddir(projectsRoot)) {
    const archDir = join(projectsRoot, project, '_architect');
    if (!existsSync(archDir)) continue;
    for (const sid of safeReaddir(archDir)) {
      if (sid.startsWith('_')) continue; // skip _archived/
      const status = readStatus(join(archDir, sid));
      if (status) out.push(status);
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
