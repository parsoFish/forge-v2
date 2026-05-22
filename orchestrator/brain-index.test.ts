import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBrainIndex, regenerateBrainIndex } from './brain-index.ts';

function scaffoldBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-index-test-'));
  mkdirSync(join(root, 'brain', 'forge'), { recursive: true });
  mkdirSync(join(root, 'brain', 'projects', 'sample'), { recursive: true });

  writeFileSync(join(root, 'brain', 'INDEX.md'), '# Brain\n\ntop-level navigation.');
  writeFileSync(join(root, 'brain', 'forge', 'patterns.md'), '# Patterns\n\n- pattern A\n- pattern B');
  writeFileSync(join(root, 'brain', 'forge', 'antipatterns.md'), '# Antipatterns\n');
  writeFileSync(join(root, 'brain', 'forge', 'decisions.md'), '# Decisions\n');
  writeFileSync(join(root, 'brain', 'forge', 'operations.md'), '# Operations\n');
  writeFileSync(join(root, 'brain', 'forge', 'reference.md'), '# Reference\n');

  writeFileSync(join(root, 'brain', 'projects', 'sample', 'profile.md'), '# Sample profile\n\nhard constraints.');
  writeFileSync(join(root, 'brain', 'projects', 'sample', 'patterns.md'), '# Sample patterns\n');

  return root;
}

test('loadBrainIndex: includes all forge category indexes', () => {
  const root = scaffoldBrain();
  const output = loadBrainIndex({ cwd: root });

  for (const rel of [
    'brain/INDEX.md',
    'brain/forge/patterns.md',
    'brain/forge/antipatterns.md',
    'brain/forge/decisions.md',
    'brain/forge/operations.md',
    'brain/forge/reference.md',
  ]) {
    assert.ok(output.includes(`<!-- BRAIN INDEX: ${rel} -->`), `marker for ${rel}`);
  }
  assert.ok(output.includes('top-level navigation.'));
  assert.ok(output.includes('pattern A'));
});

test('loadBrainIndex: scope adds project profile + project category indexes when present', () => {
  const root = scaffoldBrain();
  const output = loadBrainIndex({ cwd: root, scope: 'sample' });

  assert.ok(output.includes('<!-- BRAIN INDEX: brain/projects/sample/profile.md -->'));
  assert.ok(output.includes('<!-- BRAIN INDEX: brain/projects/sample/patterns.md -->'));
  assert.ok(output.includes('hard constraints.'));
});

test('loadBrainIndex: missing project category files are silently skipped', () => {
  const root = scaffoldBrain();
  const output = loadBrainIndex({ cwd: root, scope: 'sample' });

  // antipatterns.md and decisions.md don't exist for `sample` — skipped.
  assert.ok(!output.includes('brain/projects/sample/antipatterns.md'));
  assert.ok(!output.includes('brain/projects/sample/decisions.md'));
});

test('loadBrainIndex: missing forge category emits a (missing) marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-empty-'));
  // Don't scaffold — let the loader hit missing files.
  const output = loadBrainIndex({ cwd: root });
  assert.ok(output.includes('(missing)'));
});

test('loadBrainIndex: output is deterministic across invocations (cache-friendly)', () => {
  const root = scaffoldBrain();
  const a = loadBrainIndex({ cwd: root });
  const b = loadBrainIndex({ cwd: root });
  assert.equal(a, b);
});

test('loadBrainIndex: nonexistent scope adds nothing', () => {
  const root = scaffoldBrain();
  const baseline = loadBrainIndex({ cwd: root });
  const scoped = loadBrainIndex({ cwd: root, scope: 'does-not-exist' });
  assert.equal(scoped, baseline);
});

// ===========================================================================
// regenerateBrainIndex
// ===========================================================================

function scaffoldBrainForRegen(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-index-regen-'));
  mkdirSync(join(root, 'brain', 'forge', 'themes'), { recursive: true });
  mkdirSync(join(root, 'brain', '_raw', 'docs'), { recursive: true });
  mkdirSync(join(root, 'brain', '_raw', 'cycles'), { recursive: true });

  writeFileSync(join(root, 'brain', 'forge', 'themes', 't1.md'), '# t1\n');
  writeFileSync(join(root, 'brain', 'forge', 'themes', 't2.md'), '# t2\n');
  writeFileSync(join(root, 'brain', 'forge', 'themes', 'README.md'), '# template — excluded\n');

  mkdirSync(join(root, 'brain', 'projects', 'alpha', 'themes'), { recursive: true });
  writeFileSync(
    join(root, 'brain', 'projects', 'alpha', 'profile.md'),
    `---
project: alpha
status: active
---

# alpha

A simple example project. Stack is TypeScript.

## Taste signals
`,
  );
  writeFileSync(join(root, 'brain', 'projects', 'alpha', 'themes', 'a1.md'), '# a1\n');

  mkdirSync(join(root, 'brain', 'projects', 'beta', 'themes'), { recursive: true });
  writeFileSync(
    join(root, 'brain', 'projects', 'beta', 'profile.md'),
    `---
project: beta
---

# beta

A second project for testing.
`,
  );

  // contamination dir — must be EXCLUDED from the regenerated index.
  mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_1', 'themes'), {
    recursive: true,
  });

  writeFileSync(join(root, 'brain', '_raw', 'docs', 'r1.md'), '# raw\n');
  writeFileSync(join(root, 'brain', '_raw', 'cycles', 'c1.md'), '# cycle\n');

  return root;
}

test('regenerateBrainIndex: counts themes + projects + raw sources from filesystem', () => {
  const root = scaffoldBrainForRegen();
  const result = regenerateBrainIndex({ cwd: root });
  assert.equal(result.stats.forgeThemeCount, 2, 'two forge themes (README excluded)');
  assert.equal(result.stats.projectThemeCount, 1, 'one project theme (alpha/a1.md)');
  assert.equal(result.stats.projects.length, 2, 'alpha + beta (contamination excluded)');
  assert.equal(result.stats.rawCount, 2, 'two raw sources');
});

test('regenerateBrainIndex: lists projects by name with one-paragraph hook', () => {
  const root = scaffoldBrainForRegen();
  const result = regenerateBrainIndex({ cwd: root });
  assert.ok(result.content.includes('[alpha](./projects/alpha/profile.md)'));
  assert.ok(result.content.includes('A simple example project.'));
  assert.ok(result.content.includes('[beta](./projects/beta/profile.md)'));
  // Contamination dir must NOT appear in the index.
  assert.ok(!result.content.includes('__chained_test_proj'));
});

test('regenerateBrainIndex: write=true creates INDEX.md byte-stable on repeat invocation', () => {
  const root = scaffoldBrainForRegen();
  const first = regenerateBrainIndex({ cwd: root, write: true });
  const onDisk1 = readFileSync(first.path, 'utf8');
  assert.equal(first.changed, true);
  assert.equal(first.content, onDisk1);

  const second = regenerateBrainIndex({ cwd: root, write: true });
  const onDisk2 = readFileSync(second.path, 'utf8');
  assert.equal(second.changed, false, 'second run is a no-op (idempotent)');
  assert.equal(onDisk1, onDisk2, 'INDEX.md byte-stable on identical input');
});

test('regenerateBrainIndex: round-trip — write, mutate, regen restores expected content', () => {
  const root = scaffoldBrainForRegen();
  const first = regenerateBrainIndex({ cwd: root, write: true });
  // Mutate INDEX.md by hand.
  writeFileSync(first.path, '# tampered\n');
  const second = regenerateBrainIndex({ cwd: root, write: true });
  assert.equal(second.changed, true, 'detected tampering');
  assert.equal(readFileSync(first.path, 'utf8'), first.content, 'restored to canonical');
});
