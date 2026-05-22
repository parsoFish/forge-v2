#!/usr/bin/env node
/**
 * One-shot scrubber for the empty `__chained_test_proj_*` (and `__bench_*`)
 * directories under `brain/projects/`. These are residue from
 * `benchmarks/chained/sdk.ts:maskLiveBrain` runs that didn't clean up
 * (interrupted test, fail-before-finally, etc.).
 *
 * Tier-A only: deletes a candidate only if all of the following hold:
 *   1. Directory name matches `^__(chained_test_proj_|bench_)`.
 *   2. Directory is empty (or contains only empty subdirs).
 *   3. Directory is NOT tracked by git (i.e. would not appear in
 *      `git ls-files`).
 *
 * Each deletion is logged to stdout. A summary entry is appended to
 * `brain/log.md`. Per `docs/planning/2026-05-20-refinement/01-brain.md`
 * §"Cleanup playbook" Tier A.
 *
 * Idempotent: running twice in a row produces no further deletions.
 *
 * Usage:
 *   node --experimental-strip-types scripts/brain-scrub-test-contamination.ts [--dry-run]
 */

import { existsSync, readdirSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const CONTAMINATION_RE = /^__(chained_test_proj_|bench_)/;

function isEffectivelyEmpty(dir: string): boolean {
  // Empty means: contains no files and no non-empty subdirectories.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      return false;
    }
    if (st.isFile()) return false;
    if (st.isDirectory() && !isEffectivelyEmpty(full)) return false;
  }
  return true;
}

function isGitTracked(forgeRoot: string, relPath: string): boolean {
  try {
    const out = execSync(`git -C "${forgeRoot}" ls-files --error-unmatch -- "${relPath}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

type ScrubReport = {
  forgeRoot: string;
  candidates: string[];
  deleted: string[];
  skippedNonEmpty: string[];
  skippedTracked: string[];
  dryRun: boolean;
};

export function scrubTestContamination(opts: {
  forgeRoot?: string;
  dryRun?: boolean;
} = {}): ScrubReport {
  const forgeRoot = opts.forgeRoot ?? resolve(import.meta.dirname, '..');
  const projectsRoot = join(forgeRoot, 'brain', 'projects');
  const report: ScrubReport = {
    forgeRoot,
    candidates: [],
    deleted: [],
    skippedNonEmpty: [],
    skippedTracked: [],
    dryRun: !!opts.dryRun,
  };
  if (!existsSync(projectsRoot)) return report;

  for (const entry of readdirSync(projectsRoot)) {
    if (!CONTAMINATION_RE.test(entry)) continue;
    const full = join(projectsRoot, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    report.candidates.push(full);
    if (!isEffectivelyEmpty(full)) {
      report.skippedNonEmpty.push(full);
      continue;
    }
    const rel = `brain/projects/${entry}`;
    if (isGitTracked(forgeRoot, rel)) {
      report.skippedTracked.push(full);
      continue;
    }
    if (opts.dryRun) {
      report.deleted.push(full);
      continue;
    }
    try {
      // recursive: true even for empty dirs — Node's rm refuses to remove
      // directories without it (EISDIR).
      rmSync(full, { recursive: true, force: true });
      report.deleted.push(full);
    } catch (err) {
      process.stderr.write(`failed to delete ${full}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return report;
}

function appendLogEntry(report: ScrubReport): void {
  const log = join(report.forgeRoot, 'brain', 'log.md');
  if (!existsSync(log)) return;
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${date}] cleanup pass — brain-scrub-test-contamination\n\n` +
    `- ${report.deleted.length} Tier-A deletes (empty, untracked, matching \`__chained_test_proj_*\` / \`__bench_*\`)\n` +
    (report.skippedNonEmpty.length > 0
      ? `- ${report.skippedNonEmpty.length} candidate(s) skipped — non-empty\n`
      : '') +
    (report.skippedTracked.length > 0
      ? `- ${report.skippedTracked.length} candidate(s) skipped — git-tracked\n`
      : '') +
    `- scrubber: \`scripts/brain-scrub-test-contamination.ts\`\n`;
  appendFileSync(log, entry);
}

// ---------- CLI ----------

const isCli = process.argv[1] && process.argv[1].endsWith('brain-scrub-test-contamination.ts');
if (isCli) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const report = scrubTestContamination({ dryRun });

  process.stdout.write(
    `brain-scrub-test-contamination${dryRun ? ' (dry-run)' : ''}\n` +
      `  forge root:       ${report.forgeRoot}\n` +
      `  candidates:       ${report.candidates.length}\n` +
      `  deleted:          ${report.deleted.length}\n` +
      `  skipped (non-empty): ${report.skippedNonEmpty.length}\n` +
      `  skipped (tracked):   ${report.skippedTracked.length}\n`,
  );
  for (const d of report.deleted) {
    process.stdout.write(`  ${dryRun ? 'would-delete' : 'deleted'}: ${d}\n`);
  }
  for (const s of report.skippedNonEmpty) {
    process.stdout.write(`  skipped (non-empty): ${s}\n`);
  }
  for (const s of report.skippedTracked) {
    process.stdout.write(`  skipped (tracked): ${s}\n`);
  }

  if (!dryRun && report.deleted.length > 0) {
    appendLogEntry(report);
  }
}
