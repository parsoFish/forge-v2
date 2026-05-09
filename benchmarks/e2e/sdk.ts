/**
 * Bench harness for the end-to-end review-loop bench. One call ≈ one full
 * cycle (PM → developer-loop → review-Ralph → merge) against one fixture.
 *
 * Tempdir layout (mirrors the live forge root the orchestrator expects):
 *   <tempdir>/
 *     brain/, skills/, docs/, orchestrator/, loops/  (read-only symlinks)
 *     projects/<name>/  ← real git repo:
 *                            main branch = seed tree (committed)
 *                            initiative-<id> branch = where the cycle runs
 *     _queue/in-flight/<initiative-id>.md  ← copied from fixture
 *     _queue/done/                          ← orchestrator moves here on merge
 *     bin/{gh, vhs, npx}                    ← PATH shims
 *     _pr-metadata.json                     ← gh shim records PR state here
 *
 * The `gh` shim is smarter than the reject-everything shim from
 * recorder-shims.ts — it handles `pr create` (records metadata + outputs a
 * fake URL) and `pr merge` (fast-forwards the initiative branch into main
 * locally + marks metadata as merged). This lets the orchestrator's
 * gh-pr-merge call succeed in bench mode without touching real GitHub.
 *
 * After the cycle completes, bench scoring runs target-spec checks against
 * the merged worktree (i.e., main branch with the initiative's commits).
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCycle, type CycleInput, type CycleResult } from '../../orchestrator/cycle.ts';
import {
  VHS_SHIM_SCRIPT,
  NPX_PLAYWRIGHT_SHIM_SCRIPT,
} from '../_lib/recorder-shims.ts';
import { simulatorVerdict, runSpecChecks, type TargetSpec } from './simulator.ts';
import type { ReviewerGateState } from '../../orchestrator/reviewer-stage2.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

export type RunE2eInput = {
  fixtureId: string;
  initiativeId: string;
  /** Absolute path to the fixture's seed worktree (initial state of `main`). */
  seedTreePath: string;
  /** Absolute path to the fixture's manifest.md. */
  manifestPath: string;
  projectName: string;
  /** Target spec — used by the simulator to decide approve vs send-back. */
  spec: TargetSpec;
  /** Iteration cap for the review-Ralph loop. Default 3 (1 prep + 2 send-backs). */
  reviewIterationCap?: number;
  /** Per-iteration USD budget for the review-Ralph. Default 1.0. */
  reviewIterationBudgetUsd?: number;
  /** Argv for the project's quality-gate command. Default inferred from package.json presence. */
  qualityGateCmd?: string[];
};

export type RunE2eResult = {
  tempdir: string;
  worktreePath: string;
  cycleResult: CycleResult | null;
  /** Did the cycle throw? */
  cycleThrew: { kind: string; message: string } | null;
  /** Round telemetry from the verdict-gate. */
  reviewerGateState: ReviewerGateState;
  /** Spec-check results re-run after the cycle (orchestrator-verified ground truth). */
  postMergeSpecResults: ReturnType<typeof runSpecChecks> | null;
  /** Did the gh shim record a successful merge? */
  merged: boolean;
};

export function setupTempdir(input: RunE2eInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-e2e-'));

  // Symlink the forge core directories the orchestrator depends on.
  for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
    symlinkSync(resolve(FORGE_ROOT, sub), resolve(dir, sub));
  }

  // Copy the seed tree into projects/<name>/ and turn it into a git repo.
  if (!existsSync(input.seedTreePath)) {
    throw new Error(`seed tree path does not exist: ${input.seedTreePath}`);
  }
  const projDir = resolve(dir, 'projects', input.projectName);
  mkdirSync(projDir, { recursive: true });
  cpSync(input.seedTreePath, projDir, { recursive: true });

  // Initialise as a git repo with main + initiative branch.
  initGitRepo(projDir, input.initiativeId);

  // Copy manifest into _queue/in-flight/.
  if (!existsSync(input.manifestPath)) {
    throw new Error(`manifest path does not exist: ${input.manifestPath}`);
  }
  const queueDir = resolve(dir, '_queue', 'in-flight');
  mkdirSync(queueDir, { recursive: true });
  cpSync(input.manifestPath, resolve(queueDir, `${input.initiativeId}.md`));

  // Pre-create the queue destination dirs so moveTo() doesn't fail.
  mkdirSync(resolve(dir, '_queue', 'pending'), { recursive: true });
  mkdirSync(resolve(dir, '_queue', 'ready-for-review'), { recursive: true });
  mkdirSync(resolve(dir, '_queue', 'done'), { recursive: true });
  mkdirSync(resolve(dir, '_queue', 'failed'), { recursive: true });

  // PATH shims: gh (smart — records PR state locally), vhs, npx.
  const binDir = resolve(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeShim(resolve(binDir, 'gh'), buildGhShimScript(projDir, dir));
  writeShim(resolve(binDir, 'vhs'), VHS_SHIM_SCRIPT);
  writeShim(resolve(binDir, 'npx'), NPX_PLAYWRIGHT_SHIM_SCRIPT);

  return dir;
}

function writeShim(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function initGitRepo(projDir: string, initiativeId: string): void {
  // Idempotent: skip if already a git repo (shouldn't happen, but defensive).
  if (existsSync(resolve(projDir, '.git'))) return;
  const sh = (cmd: string, args: string[]): void => {
    execFileSync(cmd, args, { cwd: projDir, stdio: 'pipe' });
  };
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'bench@forge.local']);
  sh('git', ['config', 'user.name', 'forge bench']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', 'initial commit (bench seed)']);
  sh('git', ['checkout', '-q', '-b', `initiative-${initiativeId}`]);
}

/**
 * The `gh` shim handles two subcommands:
 *   `gh pr create --body-file <path> --title <title>` → records the PR
 *     metadata to `<tempdir>/_pr-metadata.json` and prints a fake URL.
 *   `gh pr merge --merge --delete-branch` → fast-forwards the initiative
 *     branch into main locally and marks metadata as merged.
 *
 * Anything else exits non-zero with a stderr message. Implemented as a node
 * script so we can use child_process.execFileSync for the git plumbing.
 */
function buildGhShimScript(projDir: string, tempdir: string): string {
  // Inline the project + tempdir paths so the shim doesn't need env-var
  // wiring. Single-fixture bench → single tempdir per setup.
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJ = ${JSON.stringify(projDir)};
const TEMPDIR = ${JSON.stringify(tempdir)};
const META_PATH = path.join(TEMPDIR, '_pr-metadata.json');

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { return null; }
}
function saveMeta(m) { fs.writeFileSync(META_PATH, JSON.stringify(m, null, 2)); }

const argv = process.argv.slice(2);
const sub = argv[0];

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

try {
  if (sub === 'pr' && argv[1] === 'create') {
    const bodyFile = flag('--body-file');
    const title = flag('--title') ?? 'PR';
    let body = '';
    if (bodyFile && fs.existsSync(bodyFile)) body = fs.readFileSync(bodyFile, 'utf8');
    const url = 'https://bench.local/pr/1';
    saveMeta({ created: true, merged: false, url, title, body });
    console.log(url);
    process.exit(0);
  }
  if (sub === 'pr' && argv[1] === 'merge') {
    const meta = loadMeta();
    if (!meta || !meta.created) {
      process.stderr.write('[gh shim] no PR has been created yet\\n');
      process.exit(1);
    }
    // Identify the current branch (initiative-<id>) and fast-forward main.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
    if (!branch.startsWith('initiative-')) {
      process.stderr.write('[gh shim] current branch is not an initiative branch: ' + branch + '\\n');
      process.exit(1);
    }
    // Commit any pending work before checkout (do NOT reset --hard — that
    // would wipe the reviewer agent's uncommitted source files written in
    // its last iteration). Anything Ralph-scratch (AGENT.md / fix_plan.md /
    // PROMPT.md / node_modules) is in .gitignore so 'git add -A' skips it.
    // Untracked files outside the gitignore that don't conflict with main
    // would survive checkout; explicit clean just removes ignored Ralph
    // scratch so 'git checkout main' has a tidy working tree.
    try {
      execFileSync('git', ['add', '-A'], { cwd: PROJ, stdio: 'pipe' });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-q', '-m', 'chore(review): final reviewer iteration'],
        { cwd: PROJ, stdio: 'pipe' },
      );
    } catch { /* nothing to commit is fine */ }
    try {
      execFileSync('git', ['clean', '-fdX', '--exclude=node_modules'], { cwd: PROJ, stdio: 'pipe' });
    } catch { /* best-effort */ }
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: PROJ, stdio: 'pipe' });
    execFileSync('git', ['merge', '--ff-only', '-q', branch], { cwd: PROJ, stdio: 'pipe' });
    if (argv.includes('--delete-branch')) {
      try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJ, stdio: 'pipe' }); }
      catch { /* best effort */ }
    }
    saveMeta({ ...meta, merged: true, mergedBranch: branch });
    console.log('Merged ' + branch + ' into main (bench).');
    process.exit(0);
  }
  process.stderr.write('[gh shim] unsupported subcommand: ' + argv.join(' ') + '\\n');
  process.exit(1);
} catch (err) {
  process.stderr.write('[gh shim] error: ' + (err instanceof Error ? err.message : String(err)) + '\\n');
  process.exit(2);
}
`;
}

export function cleanupTempdir(tempdir: string): void {
  try {
    rmSync(tempdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export type GhMetadata = {
  created: boolean;
  merged: boolean;
  mergedBranch?: string;
  url?: string;
  title?: string;
  body?: string;
};

export function readGhMetadata(tempdir: string): GhMetadata | null {
  const path = join(tempdir, '_pr-metadata.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GhMetadata;
  } catch {
    return null;
  }
}

/**
 * Run a single end-to-end fixture. Sets up the tempdir, invokes runCycle
 * with the simulator-driven verdict-provider, runs post-merge spec checks
 * against the merged worktree, and returns structured telemetry.
 *
 * The bench harness (score.ts) calls this once per fixture and feeds the
 * result into scoring.ts. Tempdir cleanup is the caller's responsibility
 * (so failed runs can be inspected).
 */
export async function runE2e(input: RunE2eInput): Promise<RunE2eResult> {
  const tempdir = setupTempdir(input);
  const projDir = resolve(tempdir, 'projects', input.projectName);
  const queueManifestPath = resolve(tempdir, '_queue', 'in-flight', `${input.initiativeId}.md`);
  const qualityGateCmd =
    input.qualityGateCmd ??
    (existsSync(resolve(projDir, 'package.json'))
      ? ['npm', 'test', '--silent']
      : ['true']);

  const reviewerGateState: ReviewerGateState = {
    invocations: 0,
    verdicts: [],
    qualityGateResults: [],
  };

  // Set PATH so the orchestrator's gh / vhs / npx calls hit our shims.
  const originalPath = process.env.PATH ?? '';
  process.env.PATH = `${resolve(tempdir, 'bin')}:${originalPath}`;
  process.env.GH_TOKEN = 'invalid';

  const cycleInput: CycleInput = {
    initiativeId: input.initiativeId,
    manifestPath: queueManifestPath,
    projectRepoPath: projDir,
    worktreePath: projDir,
    qualityGateCmd,
    reviewIterationCap: input.reviewIterationCap ?? 3,
    reviewIterationBudgetUsd: input.reviewIterationBudgetUsd ?? 1.0,
    getVerdict: async (ctx) => {
      const preComputedSpecResults = runSpecChecks(ctx.worktreePath, input.spec);
      const verdict = await simulatorVerdict({
        ctx,
        spec: input.spec,
        preComputedSpecResults,
      });
      return verdict;
    },
  };

  let cycleResult: CycleResult | null = null;
  let cycleThrew: RunE2eResult['cycleThrew'] = null;
  try {
    cycleResult = await runCycle(cycleInput);
    // Surface gate-state telemetry via the event log (durable across the
    // gh-shim's post-merge `git clean`). The orchestrator's runReviewer
    // emits a final 'reviewer.end' event with metadata.gate_invocations
    // and metadata.verdicts_summary — read those.
    Object.assign(
      reviewerGateState,
      reconstructGateStateFromEventLog(cycleResult.log_path),
    );
  } catch (err) {
    cycleThrew = {
      kind: 'cycle_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    process.env.PATH = originalPath;
  }

  const postMergeSpecResults = runSpecChecks(projDir, input.spec);
  const ghMetadata = readGhMetadata(tempdir);
  const merged = ghMetadata?.merged === true;

  return {
    tempdir,
    worktreePath: projDir,
    cycleResult,
    cycleThrew,
    reviewerGateState,
    postMergeSpecResults,
    merged,
  };
}

/**
 * Reconstruct review-Ralph round telemetry from the orchestrator's event
 * log. Durable across the gh-shim's post-merge `git clean` (which removes
 * AGENT.md / fix_plan.md as gitignored files). Looks for the final
 * `reviewer.end` event's metadata.gate_invocations and verdicts_summary.
 */
function reconstructGateStateFromEventLog(logPath: string): Partial<ReviewerGateState> {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return { invocations: 0, verdicts: [] };
  }
  let invocations = 0;
  let verdictKinds: Array<'approve' | 'send-back'> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evt: { phase?: string; skill?: string; event_type?: string; metadata?: Record<string, unknown> };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.phase !== 'review-loop' || evt.skill !== 'reviewer') continue;
    if (evt.event_type !== 'end' && evt.event_type !== 'error') continue;
    const md = evt.metadata ?? {};
    if (typeof md.gate_invocations === 'number') invocations = md.gate_invocations;
    if (Array.isArray(md.verdicts_summary)) {
      verdictKinds = (md.verdicts_summary as unknown[]).filter(
        (v): v is 'approve' | 'send-back' => v === 'approve' || v === 'send-back',
      );
    }
  }
  // We only have the verdict KINDS in the event log (not the full Verdict
  // objects with rationale/feedback). Synthesise minimal Verdict shells so
  // downstream code (caseScore) sees the right round count.
  const verdicts = verdictKinds.map((kind) =>
    kind === 'approve'
      ? { kind: 'approve' as const, rationale: '' }
      : { kind: 'send-back' as const, rationale: '', feedback: [] },
  );
  return { invocations, verdicts };
}
