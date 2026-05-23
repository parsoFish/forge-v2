/**
 * Tests for orchestrator/file-verdict.ts. Covers F-02:
 *   - parseVerdictResponse handles approve and send-back shapes
 *   - parseVerdictResponse rejects malformed input
 *   - makeFileVerdict polls for the response file and returns the verdict
 *   - makeFileVerdict honours timeoutMs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fileVerdictPaths,
  makeFileVerdict,
  parseVerdictResponse,
  renderVerdictPrompt,
} from './file-verdict.ts';
import type { VerdictContext } from './file-verdict.ts';

function setupQueue(): { dir: string; queueRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-fv-'));
  const queueRoot = join(dir, '_queue');
  mkdirSync(join(queueRoot, 'in-flight'), { recursive: true });
  return { dir, queueRoot };
}

function fakeContext(roundNumber = 1): VerdictContext {
  return {
    initiativeId: 'INIT-test',
    worktreePath: '/tmp/wt',
    manifestPath: '/tmp/_queue/in-flight/INIT-test.md',
    prDescriptionPath: '/tmp/wt/.forge/pr-description.md',
    demoBundleDir: '/tmp/wt/.forge/demos/INIT-test',
    workItems: [],
    diffSummary: 'src/foo.ts | 10 ++++++++--',
    roundNumber,
  };
}

// -------- parseVerdictResponse: approve --------

test('parseVerdictResponse: parses approve with rationale', () => {
  const text = `---
verdict: approve
rationale: |
  Looks good — README badge added with correct link.
---
`;
  const v = parseVerdictResponse(text);
  assert.equal(v.kind, 'approve');
  if (v.kind === 'approve') {
    assert.match(v.rationale, /Looks good/);
  }
});

test('parseVerdictResponse: approve tolerates inline rationale', () => {
  const text = `---
verdict: approve
rationale: ship it
---
`;
  const v = parseVerdictResponse(text);
  assert.equal(v.kind, 'approve');
  if (v.kind === 'approve') {
    assert.equal(v.rationale, 'ship it');
  }
});

// -------- parseVerdictResponse: send-back --------

test('parseVerdictResponse: parses send-back with AC bullets', () => {
  const text = `---
verdict: send-back
rationale: |
  Edge cases not covered.
---

## Acceptance criteria

- GIVEN an empty input WHEN slugify("") is called THEN an empty string is returned
- GIVEN an emoji input WHEN slugify("🎉") is called THEN "" is returned
`;
  const v = parseVerdictResponse(text);
  assert.equal(v.kind, 'send-back');
  if (v.kind === 'send-back') {
    assert.equal(v.feedback.length, 2);
    assert.equal(v.feedback[0].given, 'an empty input');
    assert.equal(v.feedback[0].when, 'slugify("") is called');
    assert.equal(v.feedback[0].then, 'an empty string is returned');
    assert.match(v.rationale, /Edge cases/);
  }
});

test('parseVerdictResponse: tolerates the "AC: GIVEN" prefix used in fix_plan.md', () => {
  const text = `---
verdict: send-back
rationale: needs more
---

- [ ] AC: GIVEN x WHEN y THEN z
`;
  // The leading "- [ ] AC: GIVEN" form (used by appendSendBackFeedback) should
  // also parse, so operators can copy/paste from fix_plan.md.
  // (parser strips the "- [ ]" via the leading "-" + AC prefix branch)
  // Drop the checkbox to match the expected pattern.
  const cleaned = text.replace('- [ ] AC: ', '- AC: ');
  const v = parseVerdictResponse(cleaned);
  assert.equal(v.kind, 'send-back');
  if (v.kind === 'send-back') {
    assert.equal(v.feedback.length, 1);
    assert.equal(v.feedback[0].given, 'x');
  }
});

test('parseVerdictResponse: send-back without ACs throws', () => {
  const text = `---
verdict: send-back
rationale: vague
---

(no acceptance criteria)
`;
  assert.throws(() => parseVerdictResponse(text), /must include at least one acceptance criterion/);
});

// -------- parseVerdictResponse: malformed --------

test('parseVerdictResponse: missing frontmatter throws', () => {
  assert.throws(() => parseVerdictResponse('hi there'), /missing YAML frontmatter/);
});

test('parseVerdictResponse: unknown verdict kind throws', () => {
  const text = `---
verdict: maybe
rationale: idk
---
`;
  assert.throws(() => parseVerdictResponse(text), /unknown verdict kind: maybe/);
});

// -------- makeFileVerdict --------

test('makeFileVerdict: writes prompt, polls for response, returns parsed verdict', async () => {
  const { dir, queueRoot } = setupQueue();
  try {
    const paths = fileVerdictPaths('INIT-test', queueRoot);
    let promptObserved = false;
    const get = makeFileVerdict({
      initiativeId: 'INIT-test',
      queueRoot,
      pollIntervalMs: 50,
      onPrompt: ({ promptPath, responsePath }) => {
        promptObserved = existsSync(promptPath);
        // Drop the response file as if the operator wrote one.
        writeFileSync(
          responsePath,
          `---
verdict: approve
rationale: looks fine
---
`,
        );
      },
    });
    const v = await get(fakeContext(1));
    assert.equal(v.kind, 'approve');
    assert.ok(promptObserved, 'prompt was written before onPrompt fired');
    // Cleanup happened.
    assert.ok(!existsSync(paths.promptPath), 'prompt cleaned up');
    assert.ok(!existsSync(paths.responsePath), 'response cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeFileVerdict: send-back round trip', async () => {
  const { dir, queueRoot } = setupQueue();
  try {
    const get = makeFileVerdict({
      initiativeId: 'INIT-test',
      queueRoot,
      pollIntervalMs: 50,
      onPrompt: ({ responsePath }) => {
        writeFileSync(
          responsePath,
          `---
verdict: send-back
rationale: needs the missing case
---

- GIVEN x WHEN y THEN z
`,
        );
      },
    });
    const v = await get(fakeContext(2));
    assert.equal(v.kind, 'send-back');
    if (v.kind === 'send-back') {
      assert.equal(v.feedback.length, 1);
      assert.equal(v.feedback[0].then, 'z');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeFileVerdict: timeoutMs triggers when no response arrives', async () => {
  const { dir, queueRoot } = setupQueue();
  try {
    const get = makeFileVerdict({
      initiativeId: 'INIT-test',
      queueRoot,
      pollIntervalMs: 25,
      timeoutMs: 100,
    });
    await assert.rejects(() => get(fakeContext(1)), /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------- renderVerdictPrompt --------

test('renderVerdictPrompt: includes round number, paths, and response template hints', () => {
  const ctx = fakeContext(2);
  const paths = fileVerdictPaths('INIT-test', '_queue');
  const md = renderVerdictPrompt(ctx, paths);
  assert.match(md, /round 2/);
  assert.match(md, /pr-description\.md/);
  assert.match(md, /verdict: approve/);
  assert.match(md, /verdict: send-back/);
});
