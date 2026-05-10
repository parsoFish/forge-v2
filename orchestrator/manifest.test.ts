/**
 * Tests for the initiative-manifest module — parse, validate, serialise, write.
 * Used by the architect (to write valid manifests) and the orchestrator
 * (to read them when claiming).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseManifest,
  serializeManifest,
  validateManifest,
  writeManifest,
  type InitiativeManifest,
} from './manifest.ts';

function fixture(): InitiativeManifest {
  return {
    initiative_id: 'INIT-2026-05-04-x',
    project: 'demo',
    project_repo_path: '/tmp/demo',
    created_at: '2026-05-04T18:00:00Z',
    iteration_budget: 50,
    cost_budget_usd: 25,
    phase: 'pending',
    features: [
      { feature_id: 'FEAT-1', title: 'Login', depends_on: [] },
      { feature_id: 'FEAT-2', title: 'Profile', depends_on: ['FEAT-1'] },
    ],
    body: '# Demo initiative\n\nAdd auth + profile.',
  };
}

test('serializeManifest → parseManifest round-trips fields and body', () => {
  const m = fixture();
  const md = serializeManifest(m);
  assert.match(md, /^---\n/);
  assert.match(md, /initiative_id: INIT-2026-05-04-x/);
  assert.match(md, /# Demo initiative/);

  const parsed = parseManifest(md);
  assert.equal(parsed.initiative_id, m.initiative_id);
  assert.equal(parsed.project, m.project);
  assert.equal(parsed.iteration_budget, 50);
  assert.equal(parsed.cost_budget_usd, 25);
  assert.equal(parsed.features.length, 2);
  assert.deepEqual(parsed.features[1]!.depends_on, ['FEAT-1']);
  assert.match(parsed.body, /# Demo initiative/);
});

test('validateManifest: passes a clean manifest', () => {
  const errors = validateManifest(fixture());
  assert.deepEqual(errors, []);
});

test('validateManifest: rejects missing initiative_id', () => {
  const m = { ...fixture(), initiative_id: '' };
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => e.includes('initiative_id')), `got ${JSON.stringify(errors)}`);
});

test('validateManifest: rejects malformed initiative_id', () => {
  const m = { ...fixture(), initiative_id: 'not-an-init-id' };
  const errors = validateManifest(m);
  assert.ok(
    errors.some((e) => e.includes('initiative_id') && e.includes('INIT-')),
    `got ${JSON.stringify(errors)}`,
  );
});

test('validateManifest: rejects undeclared feature dependency', () => {
  const m = fixture();
  m.features.push({ feature_id: 'FEAT-3', title: 'Settings', depends_on: ['FEAT-99'] });
  const errors = validateManifest(m);
  assert.ok(
    errors.some((e) => e.includes('depends_on') && e.includes('FEAT-99')),
    `got ${JSON.stringify(errors)}`,
  );
});

test('validateManifest: rejects feature dependency cycles', () => {
  const m = fixture();
  m.features = [
    { feature_id: 'FEAT-1', title: 'A', depends_on: ['FEAT-2'] },
    { feature_id: 'FEAT-2', title: 'B', depends_on: ['FEAT-1'] },
  ];
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => e.toLowerCase().includes('cycle')), `got ${JSON.stringify(errors)}`);
});

test('validateManifest: rejects duplicate feature ids', () => {
  const m = fixture();
  m.features.push({ feature_id: 'FEAT-1', title: 'duplicate', depends_on: [] });
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => e.includes('duplicate')), `got ${JSON.stringify(errors)}`);
});

test('validateManifest: rejects budgets ≤ 0', () => {
  const e1 = validateManifest({ ...fixture(), iteration_budget: 0 });
  const e2 = validateManifest({ ...fixture(), cost_budget_usd: -1 });
  assert.ok(e1.some((e) => e.includes('iteration_budget')));
  assert.ok(e2.some((e) => e.includes('cost_budget_usd')));
});

test('writeManifest: writes a parseable file under _queue/pending/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-manifest-'));
  try {
    const queueRoot = join(dir, '_queue');
    const m = fixture();
    const out = writeManifest(m, { queueRoot });
    assert.ok(existsSync(out), `expected file at ${out}`);
    assert.ok(out.includes('pending'), `expected pending/, got ${out}`);

    const content = readFileSync(out, 'utf8');
    const parsed = parseManifest(content);
    assert.equal(parsed.initiative_id, m.initiative_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifest: refuses to write an invalid manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-manifest-'));
  try {
    const queueRoot = join(dir, '_queue');
    const bad = { ...fixture(), initiative_id: '' };
    assert.throws(
      () => writeManifest(bad, { queueRoot }),
      /initiative_id/,
      'should throw with field name',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseManifest: tolerates manifests with no features section', () => {
  const md = `---\ninitiative_id: INIT-2026-05-04-y\nproject: demo\ncreated_at: 2026-05-04T18:00:00Z\niteration_budget: 10\ncost_budget_usd: 5\nphase: pending\n---\n\n# Body only\n`;
  const parsed = parseManifest(md);
  assert.deepEqual(parsed.features, []);
  assert.match(parsed.body, /Body only/);
});

test('parseManifest: throws on missing required fields', () => {
  const md = `---\nproject: demo\n---\n\nbody`;
  assert.throws(() => parseManifest(md), /initiative_id/);
});

// ---- F-04 quality_gate_cmd round trip ----

test('parseManifest: extracts quality_gate_cmd from frontmatter', () => {
  const md = `---\ninitiative_id: INIT-2026-05-10-qgate\nproject: demo\ncreated_at: 2026-05-10T00:00:00Z\niteration_budget: 5\ncost_budget_usd: 1\nphase: pending\nquality_gate_cmd:\n  - pytest\n  - -q\n  - tests/\n---\n\n# body\n`;
  const parsed = parseManifest(md);
  assert.deepEqual(parsed.quality_gate_cmd, ['pytest', '-q', 'tests/']);
});

test('serializeManifest → parseManifest: quality_gate_cmd round-trips', () => {
  const m: InitiativeManifest = {
    ...fixture(),
    quality_gate_cmd: ['cargo', 'test', '--all'],
  };
  const round = parseManifest(serializeManifest(m));
  assert.deepEqual(round.quality_gate_cmd, ['cargo', 'test', '--all']);
});

test('parseManifest: missing quality_gate_cmd is undefined (allowed)', () => {
  const md = `---\ninitiative_id: INIT-2026-05-10-qgate\nproject: demo\ncreated_at: 2026-05-10T00:00:00Z\niteration_budget: 5\ncost_budget_usd: 1\nphase: pending\n---\nbody`;
  const parsed = parseManifest(md);
  assert.equal(parsed.quality_gate_cmd, undefined);
});

test('validateManifest: rejects empty quality_gate_cmd array', () => {
  const m = { ...fixture(), quality_gate_cmd: [] as string[] };
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => /quality_gate_cmd/i.test(e)));
});

test('validateManifest: rejects quality_gate_cmd with empty-string entries', () => {
  const m = { ...fixture(), quality_gate_cmd: ['', 'test'] };
  const errors = validateManifest(m);
  assert.ok(errors.some((e) => /quality_gate_cmd/i.test(e)));
});

test('validateManifest: accepts a well-formed quality_gate_cmd', () => {
  const m = { ...fixture(), quality_gate_cmd: ['npm', 'test'] };
  const errors = validateManifest(m);
  assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
});
