/**
 * Focused tests for the quality-gate command builder added in F-04, plus
 * the post-2026-05-23-dogfood tightening (no-work-indicator scan +
 * requiredPaths git-diff check). See
 * [[quality-gate-cmd-must-assert-new-work]].
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeQualityGateFromCmd, type GateRunInfo } from './stop-conditions.ts';

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

// -------------------------------------------------------------------------
// Tightening 1: no-work-indicator scan (the 2026-05-23 dogfood case)
// -------------------------------------------------------------------------

test('makeQualityGateFromCmd: rejects exit-0 + "[no tests to run]" in stdout (go test pattern)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    let captured: GateRunInfo | undefined;
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "ok  github.com/x/y  0.003s [no tests to run]"; exit 0'],
      (info) => { captured = info; },
    );
    assert.equal(gate(), false, 'gate must reject exit-0 + no-tests-to-run indicator');
    assert.equal(captured?.rejectReason, 'no-work-indicator');
    assert.match(captured?.stderrTail ?? '', /no-work indicator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: rejects exit-0 + "no tests ran" (pytest empty pattern)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['sh', '-c', 'echo "no tests ran in 0.01s"; exit 0']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: rejects exit-0 + "running 0 tests" (cargo pattern)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(dir, ['sh', '-c', 'echo "running 0 tests"; exit 0']);
    assert.equal(gate(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: exit-0 + no indicator in output → passes (legit pass)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    let captured: GateRunInfo | undefined;
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "--- PASS: TestX (0.01s)"; echo "ok 1 test"; exit 0'],
      (info) => { captured = info; },
    );
    assert.equal(gate(), true);
    assert.equal(captured?.rejectReason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: indicators can be disabled with noWorkIndicators: null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "[no tests to run]"; exit 0'],
      undefined,
      { noWorkIndicators: null },
    );
    assert.equal(gate(), true, 'with indicators disabled, exit-0 alone is enough');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: a custom noWorkIndicators array overrides the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-'));
  try {
    // Default would reject "[no tests to run]"; custom set checks only for "WIDGET-NULL"
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "[no tests to run] but WIDGET-NULL"; exit 0'],
      undefined,
      { noWorkIndicators: ['WIDGET-NULL'] },
    );
    assert.equal(gate(), false, 'custom indicator should fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// Tightening 2: requiredPaths git-diff check
// -------------------------------------------------------------------------

/**
 * Set up a tiny git repo with a `main` baseline + a branch HEAD diff so the
 * requiredPaths tightening has something to check against.
 */
function setupTinyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-qg-git-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'forge-test');
  writeFileSync(join(dir, 'README.md'), '# baseline\n');
  run('add', 'README.md');
  run('commit', '-m', 'baseline');
  run('checkout', '-b', 'forge/wi');
  writeFileSync(join(dir, 'foo.go'), 'package x\n');
  writeFileSync(join(dir, 'bar_test.go'), 'package x\n');
  run('add', 'foo.go', 'bar_test.go');
  run('commit', '-m', 'add foo.go + bar_test.go');
  return dir;
}

test('makeQualityGateFromCmd: requiredPaths matched in diff → passes', () => {
  const dir = setupTinyRepo();
  try {
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "--- PASS: TestY"; exit 0'],
      undefined,
      { requiredPaths: ['bar_test.go'] },
    );
    assert.equal(gate(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: requiredPaths NOT matched in diff → rejects (the dogfood case)', () => {
  const dir = setupTinyRepo();
  try {
    let captured: GateRunInfo | undefined;
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "--- PASS: TestY"; exit 0'],
      (info) => { captured = info; },
      { requiredPaths: ['expected_test.go'] },
    );
    assert.equal(gate(), false);
    assert.equal(captured?.rejectReason, 'required-paths-missing');
    // F1.I2: rejection message is now prescriptive — must include the
    // ACTION + the specific required path so the agent can act on it.
    assert.match(captured?.stderrTail ?? '', /REJECTED/);
    assert.match(captured?.stderrTail ?? '', /ACTION REQUIRED/);
    assert.match(captured?.stderrTail ?? '', /expected_test\.go/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: requiredPaths with ≥1 match (others missing) → passes', () => {
  const dir = setupTinyRepo();
  try {
    // bar_test.go IS in diff; missing-thing is not. Any-of semantics → pass.
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "--- PASS: TestY"; exit 0'],
      undefined,
      { requiredPaths: ['missing-thing', 'bar_test.go'] },
    );
    assert.equal(gate(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: empty requiredPaths array → no tightening, exit-0 passes', () => {
  const dir = setupTinyRepo();
  try {
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'exit 0'],
      undefined,
      { requiredPaths: [] },
    );
    assert.equal(gate(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: tightenings combine — no-work indicator caught first', () => {
  const dir = setupTinyRepo();
  try {
    let captured: GateRunInfo | undefined;
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "[no tests to run]"; exit 0'],
      (info) => { captured = info; },
      { requiredPaths: ['bar_test.go'] },  // would be in diff, but indicator fires first
    );
    assert.equal(gate(), false);
    assert.equal(captured?.rejectReason, 'no-work-indicator', 'no-work indicator is checked before requiredPaths');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeQualityGateFromCmd: real dogfood-shape — go-test-no-tests + missing test file → rejects with reason', () => {
  const dir = setupTinyRepo();
  try {
    let captured: GateRunInfo | undefined;
    // Simulates the exact 2026-05-23 betterado false-pass:
    //   `go test ./...release/... -run TestReleaseDefinition` exits 0
    //   with stdout containing "[no tests to run]" and no _test.go file
    //   in the diff.
    const gate = makeQualityGateFromCmd(
      dir,
      ['sh', '-c', 'echo "ok  github.com/x/release  0.001s [no tests to run]"; exit 0'],
      (info) => { captured = info; },
      { requiredPaths: ['azuredevops/internal/service/release/resource_release_definition_test.go'] },
    );
    assert.equal(gate(), false, 'dogfood scenario must be caught by the gate now');
    assert.equal(captured?.rejectReason, 'no-work-indicator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

