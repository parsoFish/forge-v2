import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scrubTestContamination } from './brain-scrub-test-contamination.ts';

function buildFakeForge(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-scrub-test-'));
  // Init a git repo so isGitTracked has a working tree to query.
  execSync(`git -C "${root}" init -q -b main`);
  execSync(`git -C "${root}" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`);
  mkdirSync(join(root, 'brain', 'projects'), { recursive: true });
  writeFileSync(join(root, 'brain', 'log.md'), '# log\n');
  return root;
}

test('scrubTestContamination: deletes empty __chained_test_proj_* and __bench_* dirs', () => {
  const root = buildFakeForge();
  try {
    mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_1'));
    mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_2'));
    mkdirSync(join(root, 'brain', 'projects', '__bench_a'));
    mkdirSync(join(root, 'brain', 'projects', 'realproject'));
    writeFileSync(join(root, 'brain', 'projects', 'realproject', 'profile.md'), '# r\n');

    const report = scrubTestContamination({ forgeRoot: root });
    assert.equal(report.deleted.length, 3);
    assert.equal(report.candidates.length, 3, 'realproject is not a candidate');
    // realproject remains.
    assert.ok(report.deleted.every((d) => !d.endsWith('realproject')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scrubTestContamination: skips non-empty __chained_test_proj_* dirs', () => {
  const root = buildFakeForge();
  try {
    const nonEmpty = join(root, 'brain', 'projects', '__chained_test_proj_nonempty');
    mkdirSync(nonEmpty);
    writeFileSync(join(nonEmpty, 'unexpected.md'), 'payload\n');
    mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_empty'));

    const report = scrubTestContamination({ forgeRoot: root });
    assert.equal(report.deleted.length, 1);
    assert.equal(report.skippedNonEmpty.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scrubTestContamination: dry-run does not delete', () => {
  const root = buildFakeForge();
  try {
    mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_42'));
    const report = scrubTestContamination({ forgeRoot: root, dryRun: true });
    assert.equal(report.deleted.length, 1, 'reported as would-delete');
    assert.equal(report.dryRun, true);
    // Dir still on disk.
    assert.ok(
      execSync(`ls "${root}/brain/projects"`).toString().includes('__chained_test_proj_42'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scrubTestContamination: idempotent — second pass deletes nothing', () => {
  const root = buildFakeForge();
  try {
    mkdirSync(join(root, 'brain', 'projects', '__chained_test_proj_x'));
    const first = scrubTestContamination({ forgeRoot: root });
    assert.equal(first.deleted.length, 1);
    const second = scrubTestContamination({ forgeRoot: root });
    assert.equal(second.deleted.length, 0);
    assert.equal(second.candidates.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
