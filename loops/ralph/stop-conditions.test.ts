/**
 * Focused tests for the quality-gate command builder added in F-04.
 * Other stop-conditions logic is covered indirectly by the runner tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeQualityGateFromCmd } from './stop-conditions.ts';

test('makeQualityGateFromCmd: returns true when command exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['true']);
    assert.equal(gate(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false when command exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['false']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false when binary is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['this-binary-definitely-does-not-exist-99999']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: returns false on empty command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, []);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: passes additional args through', () => {
  // `sh -c "exit 7"` exits 7 — a non-zero we can be sure is from our command,
  // not a missing binary. Verifies args are forwarded.
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gateFail = makeQualityGateFromCmd(dir, ['sh', '-c', 'exit 1']);
    assert.equal(gateFail(), false);
    const gatePass = makeQualityGateFromCmd(dir, ['sh', '-c', 'exit 0']);
    assert.equal(gatePass(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
