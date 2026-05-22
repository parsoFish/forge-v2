/**
 * Integration test for scripts/backfill-aliases.ts.
 *
 * Spawns the script against a throwaway _queue/ with seeded manifests
 * across all five queue states, asserts the resulting _aliases.json is
 * non-empty and shape-correct, and proves the second run is a true no-op
 * (mint count = 0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'backfill-aliases.ts');

function mkQueueWithManifests(): { queueRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-backfill-'));
  const queueRoot = join(root, '_queue');
  for (const dir of ['pending', 'in-flight', 'ready-for-review', 'done', 'failed']) {
    mkdirSync(join(queueRoot, dir), { recursive: true });
  }
  // 3 trafficgame, 1 betterado, spread across queue states.
  const seeds: Array<{ state: string; id: string; createdAt: string; project: string }> = [
    { state: 'done', id: 'INIT-2026-05-10-trafficgame-alpha', createdAt: '2026-05-10T08:00:00Z', project: 'trafficgame' },
    { state: 'done', id: 'INIT-2026-05-11-trafficgame-beta', createdAt: '2026-05-11T08:00:00Z', project: 'trafficgame' },
    { state: 'pending', id: 'INIT-2026-05-18-betterado-release', createdAt: '2026-05-18T08:00:00Z', project: 'betterado' },
    { state: 'failed', id: 'INIT-2026-05-09-trafficgame-zero', createdAt: '2026-05-09T08:00:00Z', project: 'trafficgame' },
  ];
  for (const s of seeds) {
    writeFileSync(
      join(queueRoot, s.state, `${s.id}.md`),
      `---
initiative_id: ${s.id}
project: ${s.project}
created_at: ${s.createdAt}
iteration_budget: 5
cost_budget_usd: 1.00
phase: ${s.state}
---

body
`,
    );
  }
  return { queueRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runScript(queueRoot: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, queueRoot],
    { encoding: 'utf8' },
  );
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? -1 };
}

test('backfill: first run mints handles in created_at order; second run is a no-op', () => {
  const { queueRoot, cleanup } = mkQueueWithManifests();
  try {
    const r1 = runScript(queueRoot);
    assert.equal(r1.code, 0, `first run exit: ${r1.code}\nstderr: ${r1.stderr}`);
    assert.match(r1.stdout, /minted=4/);
    assert.match(r1.stdout, /skipped=0/);

    const regPath = join(queueRoot, '_aliases.json');
    assert.ok(existsSync(regPath), '_aliases.json was written');
    const reg = JSON.parse(readFileSync(regPath, 'utf8')) as {
      by_handle: Record<string, string>;
      by_canonical: Record<string, { handle: string }>;
      counters: Record<string, number>;
    };

    // Order matters: created_at-asc → trafficgame-zero first → traf#1.
    assert.equal(reg.by_canonical['INIT-2026-05-09-trafficgame-zero'].handle, 'traf#1');
    assert.equal(reg.by_canonical['INIT-2026-05-10-trafficgame-alpha'].handle, 'traf#2');
    assert.equal(reg.by_canonical['INIT-2026-05-11-trafficgame-beta'].handle, 'traf#3');
    assert.equal(reg.by_canonical['INIT-2026-05-18-betterado-release'].handle, 'bett#1');
    assert.equal(reg.counters.traf, 3);
    assert.equal(reg.counters.bett, 1);

    // Second run → no mints (idempotent).
    const r2 = runScript(queueRoot);
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /minted=0/);
    assert.match(r2.stdout, /skipped=4/);

    // Registry unchanged.
    const reg2 = JSON.parse(readFileSync(regPath, 'utf8'));
    assert.deepEqual(reg2, reg, 'registry unchanged on second run');
  } finally {
    cleanup();
  }
});

test('backfill: missing queue root exits non-zero', () => {
  const r = runScript('/nonexistent/path/that/should/not/be/there');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /queue root not found/);
});
