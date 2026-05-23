/**
 * S6B — tests for orchestrator/forge-reflect-cli.ts.
 *
 * Validates the slash-command CLI module pattern (council 06 dx:01):
 *   - `render(input)`         — pure: returns markdown string from disk inputs.
 *   - `writeOutput(input)`    — writes `_logs/<id>/user-feedback.md` and
 *                               auto-invokes `--rerun` per C9.
 *
 * No SDK calls; rerun is stubbed via an injectable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFeedback,
  render,
  writeOutput,
} from './forge-reflect-cli.ts';

type Harness = {
  logsRoot: string;
  cycleId: string;
  cycleDir: string;
  cleanup: () => void;
};

function setup(cycleId = 'CY-S6B-TEST'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'forge-reflect-cli-test-'));
  const logsRoot = join(root, '_logs');
  const cycleDir = join(logsRoot, cycleId);
  mkdirSync(cycleDir, { recursive: true });
  return {
    logsRoot,
    cycleId,
    cycleDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeQuestionsFile(cycleDir: string, body: string): void {
  writeFileSync(join(cycleDir, 'user-questions.md'), body);
}

// ---------------------------------------------------------------------------
// render()
// ---------------------------------------------------------------------------

test('render: with 3 numbered questions returns markdown with each numbered line', () => {
  const h = setup();
  try {
    writeQuestionsFile(
      h.cycleDir,
      [
        '# Stage 2 — Operator questions',
        '',
        '## 1. Should we adopt the new schema?',
        'Context: the proposal landed in cycle X.',
        '',
        '## 2. Was the send-back justified?',
        'The reviewer flagged spec drift on iter 3.',
        '',
        '## 3. Do we keep the auto-fix opt-out?',
        '',
      ].join('\n'),
    );
    const out = render({ cycleId: h.cycleId, logsRoot: h.logsRoot });
    // header
    assert.match(out, new RegExp(`# /forge-reflect.*${h.cycleId}`));
    // each question rendered with its number
    assert.match(out, /### 1\. Should we adopt the new schema\?/);
    assert.match(out, /### 2\. Was the send-back justified\?/);
    assert.match(out, /### 3\. Do we keep the auto-fix opt-out\?/);
    // empty answer block placeholder
    assert.match(out, /> Your answer/);
    // free-form prompt
    assert.match(out, /Anything else for the brain/i);
  } finally {
    h.cleanup();
  }
});

test('render: with 0 questions returns a "no questions" stub but keeps free-form prompt', () => {
  const h = setup();
  try {
    writeQuestionsFile(h.cycleDir, '# Stage 2\n\n_(no questions)_\n');
    const out = render({ cycleId: h.cycleId, logsRoot: h.logsRoot });
    assert.match(out, /no questions/i);
    // free-form still offered
    assert.match(out, /Anything else for the brain/i);
    assert.match(out, /> Your feedback/);
  } finally {
    h.cleanup();
  }
});

test('render: missing user-questions.md returns "reflector has not run yet" stub', () => {
  const h = setup();
  try {
    // no questions file written
    const out = render({ cycleId: h.cycleId, logsRoot: h.logsRoot });
    assert.match(out, /reflector has not.*emitted questions yet/i);
    // free-form still available
    assert.match(out, /Anything else for the brain/i);
  } finally {
    h.cleanup();
  }
});

test('render: missing cycle dir throws with a clear message', () => {
  const h = setup();
  try {
    assert.throws(
      () => render({ cycleId: 'CY-DOES-NOT-EXIST', logsRoot: h.logsRoot }),
      /cycle log directory does not exist/i,
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// writeOutput()
// ---------------------------------------------------------------------------

test('writeOutput: writes user-feedback.md in canonical format with numbered answers + freeform', async () => {
  const h = setup();
  try {
    writeQuestionsFile(
      h.cycleDir,
      [
        '## 1. Should we adopt the new schema?',
        '',
        '## 2. Was the send-back justified?',
        '',
      ].join('\n'),
    );
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: ['Yes — but only after the migration step.', 'No — operator typo on the spec.'],
      freeform: 'The dev-loop wedge on iter 4 needs a brain theme.',
      rerun: false,
    });
    assert.ok(existsSync(res.feedbackPath));
    const body = readFileSync(res.feedbackPath, 'utf8');
    assert.match(body, /# Reflection feedback/);
    assert.match(body, /## Answers to numbered questions/);
    assert.match(body, /### 1\. Should we adopt the new schema\?/);
    assert.match(body, /Yes — but only after the migration step\./);
    assert.match(body, /### 2\. Was the send-back justified\?/);
    assert.match(body, /No — operator typo on the spec\./);
    assert.match(body, /## Free-form feedback/);
    assert.match(body, /dev-loop wedge on iter 4/);
    assert.equal(res.rerun, false);
  } finally {
    h.cleanup();
  }
});

test('writeOutput: rerun:true (default per C9) invokes the reflector', async () => {
  const h = setup();
  try {
    writeQuestionsFile(h.cycleDir, '## 1. Q?\n\n');
    let invoked = false;
    let receivedCycleId: string | null = null;
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: ['A.'],
      freeform: '',
      // default rerun behaviour — pass nothing
      rerun: undefined,
      _rerunImpl: async ({ cycleId }) => {
        invoked = true;
        receivedCycleId = cycleId;
      },
    });
    assert.equal(invoked, true, 'expected rerun to fire by default');
    assert.equal(receivedCycleId, h.cycleId);
    assert.equal(res.rerun, true);
  } finally {
    h.cleanup();
  }
});

test('writeOutput: rerun:false explicit override skips the reflector invocation', async () => {
  const h = setup();
  try {
    writeQuestionsFile(h.cycleDir, '## 1. Q?\n\n');
    let invoked = false;
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: ['A.'],
      freeform: '',
      rerun: false,
      _rerunImpl: async () => {
        invoked = true;
      },
    });
    assert.equal(invoked, false, 'rerun must NOT fire when rerun:false');
    assert.equal(res.rerun, false);
  } finally {
    h.cleanup();
  }
});

test('writeOutput: missing cycle dir throws with clear message', async () => {
  const h = setup();
  try {
    await assert.rejects(
      writeOutput({
        cycleId: 'CY-DOES-NOT-EXIST',
        logsRoot: h.logsRoot,
        answers: [],
        freeform: '',
        rerun: false,
      }),
      /cycle log directory does not exist/i,
    );
  } finally {
    h.cleanup();
  }
});

test('writeOutput: with no questions still writes a free-form-only feedback file', async () => {
  const h = setup();
  try {
    // no questions file at all
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: [],
      freeform: 'A standalone observation for the brain.',
      rerun: false,
    });
    const body = readFileSync(res.feedbackPath, 'utf8');
    // no "Answers" section because no questions
    assert.doesNotMatch(body, /## Answers to numbered questions/);
    assert.match(body, /## Free-form feedback/);
    assert.match(body, /A standalone observation for the brain\./);
  } finally {
    h.cleanup();
  }
});

test('writeOutput: with no freeform writes the explicit-no-feedback placeholder', async () => {
  const h = setup();
  try {
    writeQuestionsFile(h.cycleDir, '## 1. Q?\n\n');
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: ['A.'],
      freeform: '',
      rerun: false,
    });
    const body = readFileSync(res.feedbackPath, 'utf8');
    assert.match(body, /no additional feedback this cycle/i);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// parseFeedback — canonical round-trip
// ---------------------------------------------------------------------------

test('parseFeedback: round-trips numbered answers + freeform from a writeOutput result', async () => {
  const h = setup();
  try {
    writeQuestionsFile(
      h.cycleDir,
      ['## 1. First question?', '', '## 2. Second question?', ''].join('\n'),
    );
    const res = await writeOutput({
      cycleId: h.cycleId,
      logsRoot: h.logsRoot,
      answers: ['Answer A.', 'Answer B with multiple lines.\n\nSecond paragraph.'],
      freeform: 'Free-form observation.',
      rerun: false,
    });
    const body = readFileSync(res.feedbackPath, 'utf8');
    const parsed = parseFeedback(body);
    assert.equal(parsed.answers.length, 2);
    assert.equal(parsed.answers[0].question, 'First question?');
    assert.equal(parsed.answers[0].answer.trim(), 'Answer A.');
    assert.equal(parsed.answers[1].question, 'Second question?');
    assert.match(parsed.answers[1].answer, /Answer B with multiple lines/);
    assert.match(parsed.answers[1].answer, /Second paragraph/);
    assert.match(parsed.freeform, /Free-form observation\./);
  } finally {
    h.cleanup();
  }
});

test('parseFeedback: returns empty answers when there is no Answers section', () => {
  const body = [
    '# Reflection feedback — CY-XY',
    '',
    '## Free-form feedback',
    '',
    'Just commentary.',
    '',
  ].join('\n');
  const parsed = parseFeedback(body);
  assert.deepEqual(parsed.answers, []);
  assert.match(parsed.freeform, /Just commentary/);
});
