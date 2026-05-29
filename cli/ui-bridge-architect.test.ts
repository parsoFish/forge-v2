/**
 * Tests for the architect bridge routes (ADR 020).
 *
 * Starts a real bridge against a temp `forgeRoot` with a file-seeded session
 * dir (no SDK, no spawn — `FORGE_ARCHITECT_NO_SPAWN=1`), and exercises the
 * `/api/architect/*` + `/api/plan-verdict` surface over HTTP.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startBridge } from './ui-bridge.ts';

process.env.FORGE_ARCHITECT_NO_SPAWN = '1';

let forgeRoot: string;
let url: string;
let close: () => Promise<void>;
const sid = '2026-05-29T12-00-00';

function sessionDir(s = sid): string {
  return join(forgeRoot, 'projects', 'demo', '_architect', s);
}

before(async () => {
  forgeRoot = mkdtempSync(join(tmpdir(), 'bridge-arch-'));
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      session_id: sid,
      project: 'demo',
      project_repo_path: join(forgeRoot, 'projects', 'demo'),
      phase: 'awaiting-verdict',
      round: 2,
      idea: 'Add a dark-mode toggle.',
      updated_at: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'PLAN.html'), '<!doctype html><title>PLAN</title><h1>dark mode</h1>');
  writeFileSync(
    join(dir, 'escalations.json'),
    JSON.stringify([{ id: 'esc-0', critic: 'design', question: 'Default theme?', options: [] }]),
  );
  ({ url, close } = await startBridge({ forgeRoot, port: 0 }));
});

after(async () => {
  if (close) await close();
  if (forgeRoot) rmSync(forgeRoot, { recursive: true, force: true });
});

test('GET /api/architect/sessions lists the session with escalations + planUrl', async () => {
  const body = (await (await fetch(`${url}/api/architect/sessions`)).json()) as {
    sessions: Array<{ sessionId: string; phase: string; escalations: unknown[]; planUrl: string | null }>;
  };
  const s = body.sessions.find((x) => x.sessionId === sid);
  assert.ok(s, 'session present');
  assert.equal(s!.phase, 'awaiting-verdict');
  assert.equal(s!.escalations.length, 1);
  assert.ok(s!.planUrl);
});

test('GET /api/architect/file serves PLAN.html as text/html with a path-escape guard', async () => {
  const planRes = await fetch(
    `${url}/api/architect/file/demo/${encodeURIComponent(sid)}/PLAN.html`,
  );
  assert.equal(planRes.status, 200);
  assert.match(planRes.headers.get('content-type') ?? '', /text\/html/);

  const escape = await fetch(
    `${url}/api/architect/file/demo/${encodeURIComponent(sid)}/..%2F..%2Fstatus.json`,
  );
  assert.equal(escape.status, 400);
});

test('POST /api/plan-verdict approve writes selections + resolved-decisions + advances to finalizing', async () => {
  const res = await fetch(`${url}/api/plan-verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'demo', sessionId: sid, kind: 'approve', selections: { 'esc-0': 'Follow OS' } }),
  });
  assert.equal(res.status, 200);
  const dir = sessionDir();
  assert.ok(existsSync(join(dir, 'selections.json')));
  const fb = readFileSync(join(dir, 'feedback.md'), 'utf8');
  assert.match(fb, /Resolved design decisions/);
  assert.match(fb, /Follow OS/);
  const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  assert.equal(status.phase, 'finalizing');
});

test('POST /api/architect/answer appends an interview round', async () => {
  const sid2 = '2026-05-29T13-00-00';
  const dir2 = sessionDir(sid2);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(
    join(dir2, 'status.json'),
    JSON.stringify({
      session_id: sid2,
      project: 'demo',
      project_repo_path: dir2,
      phase: 'awaiting-answers',
      round: 1,
      idea: 'x',
      updated_at: '',
    }),
  );
  const res = await fetch(`${url}/api/architect/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'demo', sessionId: sid2, answers: [{ question: 'Q', answer: 'A' }] }),
  });
  assert.equal(res.status, 200);
  const ans = JSON.parse(readFileSync(join(dir2, 'answers.json'), 'utf8'));
  assert.equal(ans[0].answers[0].answer, 'A');
  const status = JSON.parse(readFileSync(join(dir2, 'status.json'), 'utf8'));
  assert.equal(status.phase, 'interviewing');
  assert.equal(status.round, 2);
});

test('POST /api/architect/start creates a session dir + status', async () => {
  const res = await fetch(`${url}/api/architect/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'demo', idea: 'A brand new idea.' }),
  });
  assert.equal(res.status, 200);
  const { sessionId } = (await res.json()) as { sessionId: string };
  const dir = sessionDir(sessionId);
  assert.ok(existsSync(join(dir, 'status.json')));
  assert.ok(existsSync(join(dir, 'idea.md')));
  const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  assert.equal(status.phase, 'interviewing');
});
