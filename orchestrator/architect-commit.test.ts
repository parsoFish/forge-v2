/**
 * Tests for `forge architect commit <session-id>` dispatch.
 *
 * The CLI shells out to dispatchArchitectCommit; the dispatch is the part
 * that has interesting branching (approve | revise | reject) and the only
 * part that needs unit coverage. The CLI surface (cli.ts) just wires
 * argv → dispatch → stdout/stderr.
 *
 * Every test uses a fresh tempdir; nothing escapes into the real
 * `_queue/pending/` or `_logs/`.
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
  dispatchArchitectCommit,
  ArchitectCommitError,
  parsePrJson,
} from './architect-commit.ts';
import {
  writePlanDoc,
  type ArchitectSession,
  type ProposedInitiative,
} from './architect-plan.ts';
import { serializeManifest, type InitiativeManifest } from './manifest.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function setupTempProject(label: string): { projectRoot: string; queueRoot: string; logsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), `forge-arch-commit-${label}-`));
  const projectRoot = join(root, 'project');
  const queueRoot = join(root, '_queue');
  const logsRoot = join(root, '_logs');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(queueRoot, { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  return { projectRoot, queueRoot, logsRoot };
}

function fxInitiative(overrides: Partial<ProposedInitiative> = {}): ProposedInitiative {
  return {
    initiative_id: 'INIT-2026-05-23-sample-foo',
    project: 'sample',
    project_repo_path: '/tmp/projects/sample',
    title: 'Foo',
    iteration_budget: 5,
    cost_budget_usd: 1.0,
    features: [{ feature_id: 'FEAT-1', title: 'Do thing', depends_on: [] }],
    body: '# Foo initiative\n\nBody text.\n',
    ...overrides,
  };
}

function fxSession(sessionId: string, overrides: Partial<ArchitectSession> = {}): ArchitectSession {
  return {
    session_id: sessionId,
    project: 'sample',
    project_repo_path: '/tmp/projects/sample',
    vision: 'Add Foo.',
    brain_context: [],
    council: { flags: [], escalations: [], perCritic: [], totalCostUsd: 0 },
    initiatives: [fxInitiative()],
    ...overrides,
  };
}

/** Lay down a complete `<projectRoot>/_architect/<sid>/` directory including
 *  a draft manifest under `manifests/`. */
function setupSession(projectRoot: string, sessionId: string, planMutator: (planText: string) => string): void {
  const session = fxSession(sessionId);
  writePlanDoc(session, projectRoot);
  // Draft manifest under `manifests/` — the approve path promotes these.
  const manifestsDir = join(projectRoot, '_architect', sessionId, 'manifests');
  mkdirSync(manifestsDir, { recursive: true });
  const manifest: InitiativeManifest = {
    initiative_id: session.initiatives[0].initiative_id,
    project: 'sample',
    project_repo_path: '/tmp/projects/sample',
    created_at: new Date().toISOString(),
    iteration_budget: 5,
    cost_budget_usd: 1.0,
    phase: 'pending',
    origin: 'architect',
    features: [{ feature_id: 'FEAT-1', title: 'Do thing', depends_on: [] }],
    body: '# Foo initiative\n\nBody text.\n',
  };
  writeFileSync(
    join(manifestsDir, `${session.initiatives[0].initiative_id}.md`),
    serializeManifest(manifest),
  );
  // Mutate the PLAN.md to set verdict / annotations.
  const planPath = join(projectRoot, '_architect', sessionId, 'PLAN.md');
  const original = readFileSync(planPath, 'utf8');
  writeFileSync(planPath, planMutator(original));
}

// ---------------------------------------------------------------------------
// approve path
// ---------------------------------------------------------------------------

test('dispatchArchitectCommit approve: writes manifests to _queue/pending + emits plan-approved event', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('approve');
  const sid = '2026-05-23T10-00-00';
  setupSession(projectRoot, sid, (p) =>
    p.replace('<!-- verdict: approve | revise | reject -->', '<!-- verdict: approve -->'),
  );

  const result = await dispatchArchitectCommit({
    sessionId: sid,
    projectRoot,
    queueRoot,
    logsRoot,
  });

  assert.equal(result.verdict, 'approve');
  assert.equal(result.writtenManifestPaths.length, 1);
  // The manifest landed in _queue/pending/
  const pendingDir = join(queueRoot, 'pending');
  assert.ok(existsSync(pendingDir));
  const pendingFiles = readdirSync(pendingDir);
  assert.equal(pendingFiles.length, 1, 'one manifest written to _queue/pending');
  assert.match(pendingFiles[0], /^INIT-2026-05-23-sample-foo\.md$/);

  // Plan-approved event landed in events.jsonl
  const eventsPath = join(logsRoot, `_architect-${sid}`, 'events.jsonl');
  assert.ok(existsSync(eventsPath), 'events.jsonl exists');
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  const evt = JSON.parse(lines[lines.length - 1]) as {
    message: string;
    metadata: { action: string; session_id: string };
  };
  assert.equal(evt.message, 'plan-approved');
  assert.equal(evt.metadata.action, 'plan-approved');
  assert.equal(evt.metadata.session_id, sid);
});

// ---------------------------------------------------------------------------
// revise path
// ---------------------------------------------------------------------------

test('dispatchArchitectCommit revise: bundles annotations into feedback.md + emits plan-revised event', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('revise');
  const sid = '2026-05-23T11-00-00';
  setupSession(projectRoot, sid, (p) =>
    p
      .replace('<!-- verdict: approve | revise | reject -->', '<!-- verdict: revise -->')
      .replace(
        '## Proposed initiatives',
        '## Proposed initiatives\n<!-- review: please split this initiative -->',
      ),
  );

  const result = await dispatchArchitectCommit({
    sessionId: sid,
    projectRoot,
    queueRoot,
    logsRoot,
  });

  assert.equal(result.verdict, 'revise');
  assert.equal(result.writtenManifestPaths.length, 0, 'no manifests written on revise');
  assert.ok(result.feedbackPath);
  assert.ok(existsSync(result.feedbackPath ?? ''));
  const feedback = readFileSync(result.feedbackPath ?? '', 'utf8');
  assert.match(feedback, /Operator feedback/);
  assert.match(feedback, /please split this initiative/);

  // Plan-revised event landed
  const eventsPath = join(logsRoot, `_architect-${sid}`, 'events.jsonl');
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const evt = JSON.parse(lines[lines.length - 1]) as { message: string };
  assert.equal(evt.message, 'plan-revised');

  // Manifests NOT promoted to _queue/pending
  const pendingDir = join(queueRoot, 'pending');
  const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
  assert.equal(pendingFiles.length, 0);
});

// ---------------------------------------------------------------------------
// reject path
// ---------------------------------------------------------------------------

test('dispatchArchitectCommit reject: archives session dir + emits plan-rejected event', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('reject');
  const sid = '2026-05-23T12-00-00';
  setupSession(projectRoot, sid, (p) =>
    p.replace('<!-- verdict: approve | revise | reject -->', '<!-- verdict: reject -->'),
  );

  const sessionDir = join(projectRoot, '_architect', sid);
  assert.ok(existsSync(sessionDir));

  const result = await dispatchArchitectCommit({
    sessionId: sid,
    projectRoot,
    queueRoot,
    logsRoot,
  });

  assert.equal(result.verdict, 'reject');
  assert.ok(result.archivedPath);
  assert.ok(existsSync(result.archivedPath ?? ''));
  // Original session dir is gone
  assert.equal(existsSync(sessionDir), false);

  // Plan-rejected event landed
  const eventsPath = join(logsRoot, `_architect-${sid}`, 'events.jsonl');
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const evt = JSON.parse(lines[lines.length - 1]) as { message: string };
  assert.equal(evt.message, 'plan-rejected');
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

test('dispatchArchitectCommit: missing PLAN.md ⇒ ArchitectCommitError with code PLAN_NOT_FOUND', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('nopath');
  await assert.rejects(
    dispatchArchitectCommit({
      sessionId: 'nonexistent-session',
      projectRoot,
      queueRoot,
      logsRoot,
    }),
    (err: unknown) => err instanceof ArchitectCommitError && err.code === 'PLAN_NOT_FOUND',
  );
});

test('dispatchArchitectCommit: missing verdict ⇒ ArchitectCommitError with code VERDICT_NOT_SET', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('noverdict');
  const sid = '2026-05-23T13-00-00';
  // Don't change the placeholder
  setupSession(projectRoot, sid, (p) => p);
  await assert.rejects(
    dispatchArchitectCommit({
      sessionId: sid,
      projectRoot,
      queueRoot,
      logsRoot,
    }),
    (err: unknown) => err instanceof ArchitectCommitError && err.code === 'VERDICT_NOT_SET',
  );
});

// ---------------------------------------------------------------------------
// --via-pr: no-remote fallback prints stderr warning and uses local-edit
// ---------------------------------------------------------------------------

test('dispatchArchitectCommit --via-pr without remote: warns + falls back to local-edit parsing', async () => {
  const { projectRoot, queueRoot, logsRoot } = setupTempProject('viapr');
  const sid = '2026-05-23T14-00-00';
  setupSession(projectRoot, sid, (p) =>
    p.replace('<!-- verdict: approve | revise | reject -->', '<!-- verdict: approve -->'),
  );

  // Mock runGh — first call (git remote get-url) throws; commit must NOT throw.
  let calls = 0;
  const runGh = (args: string[]) => {
    calls += 1;
    if (args[0] === '-C') throw new Error('No such remote: origin');
    return '';
  };

  const result = await dispatchArchitectCommit({
    sessionId: sid,
    projectRoot,
    queueRoot,
    logsRoot,
    viaPr: true,
    runGh,
  });

  // Approve still succeeded via local-edit parsing
  assert.equal(result.verdict, 'approve');
  // The remote-check was attempted
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// parsePrJson — extracted helper, covered for parity with the local parser
// ---------------------------------------------------------------------------

test('parsePrJson: surfaces verdict + annotations from PR body + comments', () => {
  const raw = JSON.stringify({
    body: '<!-- verdict: revise -->\nSome PR description.',
    comments: [
      { body: '<!-- review: split this initiative -->\nIncoming.' },
      { body: 'No HTML comment here.' },
    ],
  });
  const { verdict, annotations } = parsePrJson(raw);
  assert.equal(verdict, 'revise');
  assert.equal(annotations.length, 1);
  assert.match(annotations[0].text, /split this initiative/);
});

test('parsePrJson: invalid JSON ⇒ null verdict + empty annotations', () => {
  const r = parsePrJson('not json');
  assert.equal(r.verdict, null);
  assert.deepEqual(r.annotations, []);
});
