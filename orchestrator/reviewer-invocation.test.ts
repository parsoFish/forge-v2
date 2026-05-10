/**
 * Tests for orchestrator/reviewer-invocation.ts. Covers F-15 — the wipe of
 * dev-loop's leftover Ralph scratch files before the reviewer-Ralph stamps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wipeRalphScratch } from './reviewer-invocation.ts';

test('wipeRalphScratch: removes PROMPT.md / AGENT.md / fix_plan.md if present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wipe-'));
  try {
    writeFileSync(join(dir, 'PROMPT.md'), 'stale dev-loop prompt content');
    writeFileSync(join(dir, 'AGENT.md'), 'stale dev-loop agent memory');
    writeFileSync(join(dir, 'fix_plan.md'), 'stale fix plan items');
    writeFileSync(join(dir, 'unrelated.txt'), 'should be left alone');

    wipeRalphScratch(dir);

    assert.equal(existsSync(join(dir, 'PROMPT.md')), false, 'PROMPT.md wiped');
    assert.equal(existsSync(join(dir, 'AGENT.md')), false, 'AGENT.md wiped');
    assert.equal(existsSync(join(dir, 'fix_plan.md')), false, 'fix_plan.md wiped');
    assert.equal(
      readFileSync(join(dir, 'unrelated.txt'), 'utf8'),
      'should be left alone',
      'other files untouched',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wipeRalphScratch: idempotent — succeeds when files already absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wipe-'));
  try {
    // No scratch files exist; wipe should not throw.
    wipeRalphScratch(dir);
    wipeRalphScratch(dir); // double-call also fine
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wipeRalphScratch: only PROMPT.md present — wipes that, no error on the other two', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wipe-'));
  try {
    writeFileSync(join(dir, 'PROMPT.md'), 'something');
    wipeRalphScratch(dir);
    assert.equal(existsSync(join(dir, 'PROMPT.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
