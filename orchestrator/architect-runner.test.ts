/**
 * Tests for the in-UI architect runner (ADR 020).
 *
 * The runner is a bounded, file-checkpointed turn driven by an injectable
 * `queryFn` seam (the `runCouncil` pattern) — so the full state machine is
 * exercised here without a live LLM. Each test uses a fresh tempdir; nothing
 * escapes into the real `_queue/` or `_logs/`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runArchitectTurn,
  writeStatus,
  readStatus,
  listArchitectSessions,
  type ArchitectStatus,
  type CouncilQueryFn,
} from './architect-runner.ts';
import { createLogger } from './logging.ts';
import { parseManifest } from './manifest.ts';

// ---------------------------------------------------------------------------
// Fakes — async generators yielding SDK-shaped `result` messages.
// ---------------------------------------------------------------------------

function* nothing(): Generator<never> {}

/** A queryFn whose structured output is chosen by the prompt content. */
function makeQueryFn(spec: {
  interview?: unknown;
  draft?: unknown;
}): CouncilQueryFn {
  return ({ prompt }) => {
    let structured: unknown = null;
    if (prompt.includes('the interview step')) structured = spec.interview;
    else if (prompt.includes('draft the initiative')) structured = spec.draft;
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, structured_output: structured };
    }
    return structured === null ? (nothing() as unknown as AsyncIterable<unknown>) : gen();
  };
}

/** A council queryFn that always returns the given verdict (flags/escalations). */
function makeCouncilFn(verdict: { flags: unknown[]; escalations: unknown[] }): CouncilQueryFn {
  return () => {
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, structured_output: verdict };
    }
    return gen();
  };
}

function setupSession(overrides?: Partial<ArchitectStatus>): {
  projectRoot: string;
  logsRoot: string;
  queueRoot: string;
  sessionId: string;
  sessionDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arch-runner-'));
  const projectRoot = join(root, 'project');
  const logsRoot = join(root, '_logs');
  const queueRoot = join(root, '_queue');
  const sessionId = '2026-05-29T10-00-00';
  const sessionDir = join(projectRoot, '_architect', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const status: ArchitectStatus = {
    session_id: sessionId,
    project: 'demo',
    project_repo_path: projectRoot,
    phase: 'interviewing',
    round: 1,
    idea: 'Add a dark-mode toggle to the settings page.',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  writeStatus(sessionDir, status);
  return { projectRoot, logsRoot, queueRoot, sessionId, sessionDir };
}

function logger(logsRoot: string, sessionId: string) {
  return createLogger(`_architect-${sessionId}`, logsRoot);
}

// ---------------------------------------------------------------------------
// Interview phase
// ---------------------------------------------------------------------------

test('interviewing → needs answers: writes questions.json + status awaiting-answers', async () => {
  const { projectRoot, logsRoot, queueRoot, sessionId, sessionDir } = setupSession();
  const queryFn = makeQueryFn({
    interview: {
      done: false,
      questions: [
        {
          question: 'Should dark mode follow the OS setting?',
          header: 'OS sync',
          options: [
            { label: 'Follow OS', description: 'Match the system theme automatically.' },
            { label: 'Manual only', description: 'Operator toggles it explicitly.' },
          ],
        },
      ],
    },
  });

  const result = await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn,
    logger: logger(logsRoot, sessionId),
  });

  assert.equal(result.phase, 'awaiting-answers');
  assert.equal(result.questions?.length, 1);
  const questionsPath = join(sessionDir, 'questions.json');
  assert.ok(existsSync(questionsPath));
  const written = JSON.parse(readFileSync(questionsPath, 'utf8'));
  assert.equal(written[0].header, 'OS sync');
  assert.equal(readStatus(sessionDir)?.phase, 'awaiting-answers');
});

test('interviewing → done flows straight through to drafting → awaiting-verdict + PLAN', async () => {
  const { projectRoot, logsRoot, queueRoot, sessionId, sessionDir } = setupSession();
  // Operator already answered a round.
  writeFileSync(
    join(sessionDir, 'answers.json'),
    JSON.stringify([
      { round: 1, answers: [{ question: 'Follow OS?', answer: 'Follow OS' }] },
    ]),
  );
  const queryFn = makeQueryFn({
    interview: { done: true },
    draft: {
      vision: 'Operator wants a dark-mode toggle that follows the OS by default.',
      initiatives: [
        {
          slug: 'dark-mode-toggle',
          title: 'Dark mode toggle',
          iteration_budget: 4,
          cost_budget_usd: 6,
          features: [
            { title: 'Theme context + OS sync' },
            { title: 'Settings toggle UI', depends_on: [0] },
          ],
          body: '## Dark mode\n\nGIVEN settings WHEN toggled THEN theme persists.',
        },
      ],
    },
  });
  const councilQueryFn = makeCouncilFn({
    flags: [],
    escalations: [
      {
        critic: 'design',
        question: 'Default theme on first load?',
        options: [
          { label: 'Follow OS', rationale: 'Least surprise.' },
          { label: 'Light', rationale: 'Brand default.' },
        ],
      },
    ],
  });

  const result = await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn,
    councilQueryFn,
    logger: logger(logsRoot, sessionId),
  });

  assert.equal(result.phase, 'awaiting-verdict');
  assert.ok(result.planPath && existsSync(result.planPath));
  assert.ok(existsSync(join(sessionDir, 'PLAN.html')));
  // Draft manifest written (not yet promoted).
  const manifestsDir = join(sessionDir, 'manifests');
  const drafts = readdirSync(manifestsDir).filter((f) => f.endsWith('.md'));
  assert.equal(drafts.length, 1);
  assert.match(drafts[0], /^INIT-\d{4}-\d{2}-\d{2}-dark-mode-toggle\.md$/);
  // Escalations keyed for the gate.
  const esc = JSON.parse(readFileSync(join(sessionDir, 'escalations.json'), 'utf8'));
  assert.equal(esc[0].id, 'esc-0');
  // Nothing in the queue yet.
  assert.ok(!existsSync(join(queueRoot, 'pending')));
  assert.equal(readStatus(sessionDir)?.phase, 'awaiting-verdict');
});

test('F-W5-1: structured interview/draft steps must NOT run the SDK in plan mode', async () => {
  // Regression for F-W5-1 (2026-05-30, surfaced by the claude-harness UI
  // validation run): `permissionMode: 'plan'` made the real draft agent end its
  // turn by calling `ExitPlanMode` (presenting a prose plan) instead of emitting
  // the `outputFormat` structured result, so `structured_output` came back empty
  // and `runDraftStep` threw "draft step returned no initiatives". Read-only must
  // be enforced by the allowedTools whitelist alone, never plan mode.
  const { projectRoot, logsRoot, queueRoot, sessionId, sessionDir } = setupSession();
  writeFileSync(
    join(sessionDir, 'answers.json'),
    JSON.stringify([{ round: 1, answers: [{ question: 'Follow OS?', answer: 'Follow OS' }] }]),
  );
  const capturedOptions: Array<Record<string, unknown>> = [];
  const queryFn: CouncilQueryFn = ({ prompt, options }) => {
    capturedOptions.push((options ?? {}) as Record<string, unknown>);
    let structured: unknown = null;
    if (prompt.includes('the interview step')) structured = { done: true };
    else if (prompt.includes('draft the initiative')) {
      structured = {
        vision: 'A one-glance compact view of a cycle trail.',
        initiatives: [
          {
            slug: 'compact-flag',
            title: 'Compact flag',
            iteration_budget: 3,
            cost_budget_usd: 2,
            features: [{ title: 'compact renderer' }],
            body: '## Compact\n\nGIVEN a cycle WHEN --compact THEN title+summary+verdict only.',
          },
        ],
      };
    }
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, structured_output: structured };
    }
    return gen();
  };
  const councilQueryFn = makeCouncilFn({ flags: [], escalations: [] });

  const result = await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn,
    councilQueryFn,
    logger: logger(logsRoot, sessionId),
  });

  // The turn must reach a PLAN — proving the structured draft was consumed.
  assert.equal(result.phase, 'awaiting-verdict');
  // Both structured steps (interview + draft) flow through runStructured and
  // carry `outputFormat`; none may run in plan mode.
  const structuredCalls = capturedOptions.filter((o) => 'outputFormat' in o);
  assert.ok(structuredCalls.length >= 1, 'expected runStructured to pass outputFormat options');
  for (const o of structuredCalls) {
    // Cause 2: plan mode makes the agent ExitPlanMode instead of emitting output.
    assert.notEqual(o.permissionMode, 'plan', 'structured step must not run in plan mode (F-W5-1)');
    // Cause 1: the SDK's outputFormat must be wrapped as { type:'json_schema', schema } —
    // passing the bare schema silently disables structured output.
    const of = o.outputFormat as { type?: string; schema?: unknown } | undefined;
    assert.equal(of?.type, 'json_schema', 'outputFormat must be { type: "json_schema", schema } (F-W5-1)');
    assert.ok(of?.schema && typeof of.schema === 'object', 'outputFormat.schema must carry the JSON schema (F-W5-1)');
  }
});

// ---------------------------------------------------------------------------
// Finalize phase
// ---------------------------------------------------------------------------

test('finalizing: bakes resolved decisions + promotes manifest to _queue/pending', async () => {
  const { projectRoot, logsRoot, queueRoot, sessionId, sessionDir } = setupSession({
    phase: 'finalizing',
  });
  // Prior escalations + the operator's selection + a feedback block.
  writeFileSync(
    join(sessionDir, 'escalations.json'),
    JSON.stringify([{ id: 'esc-0', critic: 'design', question: 'Default theme?', options: [] }]),
  );
  writeFileSync(join(sessionDir, 'selections.json'), JSON.stringify({ 'esc-0': 'Follow OS' }));
  writeFileSync(
    join(sessionDir, 'feedback.md'),
    '## Resolved design decisions\n\n- Default theme: Follow OS\n',
  );

  let draftPrompt = '';
  const queryFn: CouncilQueryFn = ({ prompt, options }) => {
    if (prompt.includes('draft the initiative')) draftPrompt = prompt;
    async function* gen(): AsyncGenerator<unknown> {
      const structured = prompt.includes('draft the initiative')
        ? {
            vision: 'Dark mode that follows the OS.',
            initiatives: [
              {
                slug: 'dark-mode-toggle',
                title: 'Dark mode toggle',
                iteration_budget: 4,
                cost_budget_usd: 6,
                features: [{ title: 'Theme context' }],
                body: '## Dark mode\n\nGIVEN settings WHEN toggled THEN theme persists.',
              },
            ],
          }
        : null;
      yield { type: 'result', total_cost_usd: 0, structured_output: structured };
    }
    void options;
    return gen();
  };
  const councilQueryFn = makeCouncilFn({ flags: [], escalations: [] });

  const result = await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn,
    councilQueryFn,
    logger: logger(logsRoot, sessionId),
  });

  assert.equal(result.phase, 'committed');
  assert.equal(result.promotedManifestPaths?.length, 1);
  // The resolved decision was fed into the draft prompt.
  assert.match(draftPrompt, /Resolved design decisions/);
  assert.match(draftPrompt, /Follow OS/);
  // Manifest landed in the queue and is valid.
  const pending = join(queueRoot, 'pending');
  const queued = readdirSync(pending).filter((f) => f.endsWith('.md'));
  assert.equal(queued.length, 1);
  const m = parseManifest(readFileSync(join(pending, queued[0]), 'utf8'));
  assert.equal(m.project, 'demo');
  assert.equal(m.origin, 'architect');
  assert.equal(readStatus(sessionDir)?.phase, 'committed');
});

// ---------------------------------------------------------------------------
// Waiting / terminal phases are no-ops
// ---------------------------------------------------------------------------

test('awaiting-answers turn is a no-op (bridge owns the wait state)', async () => {
  const { projectRoot, logsRoot, queueRoot, sessionId } = setupSession({
    phase: 'awaiting-answers',
  });
  const result = await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn: makeQueryFn({}),
    logger: logger(logsRoot, sessionId),
  });
  assert.equal(result.phase, 'awaiting-answers');
  assert.equal(result.wrote.length, 0);
});

test('missing status.json throws a clear error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arch-runner-'));
  await assert.rejects(
    runArchitectTurn({ sessionId: 'nope', projectRoot: join(root, 'p'), queryFn: makeQueryFn({}) }),
    /no status\.json/,
  );
});

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

test('runner streams tool_use events from the agent stream (drives the architect hex)', async () => {
  const { projectRoot, logsRoot, queueRoot, sessionId, sessionDir } = setupSession();
  writeFileSync(
    join(sessionDir, 'answers.json'),
    JSON.stringify([{ round: 1, answers: [{ question: 'Follow OS?', answer: 'Follow OS' }] }]),
  );
  // queryFn yields an assistant message carrying tool_use blocks, THEN a result.
  const queryFn: CouncilQueryFn = ({ prompt }) => {
    const structured = prompt.includes('the interview step')
      ? { done: true }
      : {
          vision: 'v',
          initiatives: [
            {
              slug: 'dark-mode',
              title: 'Dark mode',
              iteration_budget: 3,
              cost_budget_usd: 5,
              features: [{ title: 'toggle' }],
              body: '## x\n\nGIVEN a WHEN b THEN c.',
            },
          ],
        };
    async function* gen(): AsyncGenerator<unknown> {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'theme' } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'roadmap.md' } },
          ],
        },
      };
      yield { type: 'result', total_cost_usd: 0, structured_output: structured };
    }
    return gen();
  };

  await runArchitectTurn({
    sessionId,
    projectRoot,
    logsRoot,
    queueRoot,
    queryFn,
    councilQueryFn: makeCouncilFn({ flags: [], escalations: [] }),
    logger: logger(logsRoot, sessionId),
  });

  const log = readFileSync(join(logsRoot, `_architect-${sessionId}`, 'events.jsonl'), 'utf8');
  const events = log.trim().split('\n').map((l) => JSON.parse(l));
  const toolUses = events.filter((e) => e.event_type === 'tool_use' && e.metadata?.tool);
  assert.ok(toolUses.length >= 2, `expected tool_use events, got ${toolUses.length}`);
  assert.ok(toolUses.every((e) => e.phase === 'architect'));
  assert.ok(toolUses.some((e) => e.metadata.tool === 'Grep'));
});

test('listArchitectSessions discovers sessions across projects, skipping _archived', async () => {
  const { projectRoot, sessionId } = setupSession();
  const projectsRoot = join(projectRoot, '..'); // the `projects/` parent in the fixture
  const found = listArchitectSessions(projectsRoot);
  assert.ok(found.some((s) => s.session_id === sessionId && s.project === 'demo'));
});
