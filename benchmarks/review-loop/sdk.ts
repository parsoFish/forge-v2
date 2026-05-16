/**
 * Bench harness for the review-loop (stage 1, review-prep) benchmark.
 *
 * Phase 4.2 (drift correction): this harness previously did a bespoke
 * one-shot `sdkQuery` — a single SDK call, no Ralph loop, no verdict gate,
 * no PR/merge. That shape no longer resembles production (HIGH false-green:
 * the bench passed while testing a shape forge no longer has). It now drives
 * the **real** `runReviewer` from `orchestrator/phases/reviewer.ts` — the
 * same review-Ralph + orchestrator-side quality-gate + verdict-gate +
 * PR-open/merge path the live cycle runs — exactly the way
 * `benchmarks/e2e/sdk.ts` drives the real `runCycle`.
 *
 * Stage-1 semantics: the per-phase review-loop bench tests only stage 1 (the
 * initial prep iteration), so it omits `CycleInput.getVerdict`. The real
 * `runReviewer` then uses its `defaultGetVerdict` (approve on the first call)
 * — which is *designed for exactly this bench* (see `defaultGetVerdict` in
 * `orchestrator/phases/reviewer.ts`): the loop terminates after iteration 1's
 * prep, the orchestrator opens + merges the PR, and the bench scores the
 * resulting demo bundle + PR description with the unchanged
 * `scoring.ts:caseScore` rubric.
 *
 * Tempdir layout (mirrors the live forge root the orchestrator expects):
 *   <tempdir>/
 *     brain/, skills/, docs/, orchestrator/, loops/  (read-only symlinks)
 *     projects/<name>/  ← real git repo:
 *                            main branch = seed tree (committed)
 *                            initiative-<id> branch = where the review runs
 *                            origin = a bare clone (so `git push` works —
 *                              openPullRequest pushes the branch to origin)
 *     _queue/in-flight/<initiative-id>.md  ← copied from fixture manifest
 *     _queue/{pending,ready-for-review,done,failed}/  ← queue dirs
 *     bin/{gh, vhs, npx}                    ← PATH shims
 *     _pr-metadata.json                     ← gh shim records PR state here
 *
 * Why the smart `gh` shim (vs the reject-everything shim from
 * recorder-shims.ts): live `runReviewer` calls `openPullRequest` +
 * `mergePullRequest` after an approve verdict. The shim handles `pr create`
 * (records metadata + outputs a fake URL) and `pr merge` (fast-forwards the
 * initiative branch into main locally + marks metadata merged) so the real
 * orchestrator path completes in bench mode without touching GitHub. Unlike
 * the e2e shim it deliberately does NOT `git clean -fdX` after the merge:
 * the review-loop fixtures have no `.gitignore`, and the rubric must still
 * find `.forge/pr-description.md` + `.forge/demos/` in the worktree post-run.
 * (The proper durable fix — a pre-merge `.forge/` snapshot — is Phase 5
 * plumbing; a bench shim's housekeeping is bench plumbing, not orchestrator
 * behaviour.)
 *
 * Why the `vhs` / `npx playwright` PATH-shims: real VHS needs ffmpeg+ttyd and
 * real Playwright needs a 200MB browser bundle — neither belongs in the
 * bench's hot loop. The shims accept the same argv and produce a valid stub
 * recording (correct magic bytes, padded past the 50 KB floor) so the rubric
 * exercises exactly the same way real output would.
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

import { runReviewer as runReviewerPhase } from '../../orchestrator/phases/reviewer.ts';
import { createLogger } from '../../orchestrator/logging.ts';
import type { CycleInput } from '../../orchestrator/cycle-context.ts';
import { readWorkItemsFromDir, type WorkItem } from '../../orchestrator/work-item.ts';
import type { ReviewerToolUseSummary } from '../../orchestrator/reviewer-invocation.ts';
import {
  VHS_SHIM_SCRIPT,
  NPX_PLAYWRIGHT_SHIM_SCRIPT,
} from '../_lib/recorder-shims.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

export type RunReviewerInput = {
  fixtureId: string;
  initiativeId: string;
  /**
   * Absolute path to the fixture's seed tree (a directory under
   * benchmarks/review-loop/fixtures/<id>/branch-state/). Copied recursively
   * into <tempdir>/projects/<projectName>/. Must contain `.forge/work-items/`
   * with all WIs at status: complete.
   */
  seedTreePath: string;
  /** Absolute path to the manifest file. Copied into <tempdir>/_queue/in-flight/. */
  manifestPath: string;
  projectName: string;
  /** Project type — informs the agent's demo-tool decision. */
  projectType: 'browser' | 'cli' | 'lib' | 'rest';
  /** Quality gate command argv — the orchestrator runs this between iterations. */
  qualityGateCmd: string[];
  /** Whether the fixture is set up as a stacked PR (parents present in the manifest). */
  isStackedPr: boolean;
  /** Cap on review-Ralph iterations. Default 3 (1 prep + 2 send-back). */
  reviewIterationCap?: number;
  /** Per-iteration USD budget for the review-Ralph. Default 0.6. */
  reviewIterationBudgetUsd?: number;
};

export type ReviewerRunnerErrorKind =
  | 'manifest_missing'
  | 'seed_missing'
  | 'cycle_threw'
  | 'work_items_unreadable'
  | 'unknown_error';

export type RunReviewerResult = {
  tempdir: string;
  worktreePath: string;
  manifestRelPath: string;
  worktreeRelPath: string;
  workItems: WorkItem[];
  durationMs: number;
  costUsd: number;
  toolUseSummary: ReviewerToolUseSummary;
  /** Quality gate exit-zero status from the post-run verification. */
  qualityGatesPassed: boolean;
  /** Reviewer outcome read from the durable event log ('merged' | …). */
  resultSubtype?: string;
  runnerError?: { kind: ReviewerRunnerErrorKind; message: string };
};

/**
 * Set up an isolated tempdir for one bench run.
 *
 * The project is a real git repo (the live `runReviewer` runs `git diff
 * main...HEAD`, the verdict gate computes diff summaries, and PR open/merge
 * shell git) with a bare `origin` remote (so `openPullRequest`'s
 * `git push --set-upstream origin <branch>` succeeds locally).
 */
export function setupTempdir(input: RunReviewerInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-review-'));

  for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
    symlinkSync(resolve(FORGE_ROOT, sub), resolve(dir, sub));
  }

  if (!existsSync(input.seedTreePath)) {
    throw new Error(`seed tree path does not exist: ${input.seedTreePath}`);
  }
  const projDir = resolve(dir, 'projects', input.projectName);
  mkdirSync(projDir, { recursive: true });
  cpSync(input.seedTreePath, projDir, { recursive: true });

  if (!existsSync(input.manifestPath)) {
    throw new Error(`manifest path does not exist: ${input.manifestPath}`);
  }
  const queueDir = resolve(dir, '_queue', 'in-flight');
  mkdirSync(queueDir, { recursive: true });
  cpSync(input.manifestPath, resolve(queueDir, `${input.initiativeId}.md`));

  // Pre-create the queue destination dirs so moveTo() doesn't fail when the
  // orchestrator moves the manifest after approval.
  for (const q of ['pending', 'ready-for-review', 'done', 'failed']) {
    mkdirSync(resolve(dir, '_queue', q), { recursive: true });
  }

  // Initialise the project as a git repo: main = seed, branch =
  // initiative-<id> (the orchestrator runs the review on the current branch
  // and merges into main). Add a bare `origin` so the orchestrator's
  // `git push --set-upstream origin <branch>` (openPullRequest) works.
  initGitRepo(projDir, input.initiativeId, dir);

  // PATH shims: gh (smart — records PR state locally + ff-merges, no clean),
  // vhs, npx playwright.
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

function initGitRepo(projDir: string, initiativeId: string, tempdir: string): void {
  if (existsSync(resolve(projDir, '.git'))) return;
  const sh = (cmd: string, args: string[], cwd = projDir): void => {
    execFileSync(cmd, args, { cwd, stdio: 'pipe' });
  };
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'bench@forge.local']);
  sh('git', ['config', 'user.name', 'forge bench']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', 'initial commit (bench seed)']);

  // Bare origin so `openPullRequest`'s push has somewhere to go.
  const originDir = resolve(tempdir, '_origin.git');
  sh('git', ['init', '-q', '--bare', originDir], tempdir);
  sh('git', ['remote', 'add', 'origin', originDir]);
  sh('git', ['push', '-q', 'origin', 'main']);

  sh('git', ['checkout', '-q', '-b', `initiative-${initiativeId}`]);
}

/**
 * The `gh` shim handles:
 *   `gh pr create --body-file <path> --title <title>` → records PR metadata
 *     to `<tempdir>/_pr-metadata.json` and prints a fake URL.
 *   `gh pr merge --merge [--delete-branch]` → commits any pending work on the
 *     initiative branch, fast-forwards main, marks metadata merged. It does
 *     NOT `git clean -fdX` — `.forge/pr-description.md` + `.forge/demos/`
 *     must survive for the rubric (review-loop fixtures have no .gitignore;
 *     the durable pre-merge snapshot fix is Phase 5 plumbing).
 *
 * Anything else exits non-zero. Implemented as a node script so it can shell
 * git plumbing via child_process.
 */
function buildGhShimScript(projDir: string, tempdir: string): string {
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
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
    if (!branch.startsWith('initiative-')) {
      process.stderr.write('[gh shim] current branch is not an initiative branch: ' + branch + '\\n');
      process.exit(1);
    }
    // Commit any pending work (the reviewer's last-iteration .forge/ output)
    // BEFORE checkout. Do NOT 'git clean' — .forge/ must survive for scoring.
    try {
      execFileSync('git', ['add', '-A'], { cwd: PROJ, stdio: 'pipe' });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-q', '-m', 'chore(review): final reviewer iteration'],
        { cwd: PROJ, stdio: 'pipe' },
      );
    } catch { /* nothing to commit is fine */ }
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
  const p = join(tempdir, '_pr-metadata.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GhMetadata;
  } catch {
    return null;
  }
}

/**
 * Run the orchestrator-verified quality gate. Bench truth, not agent claim.
 * Returns true iff the command exits 0 in the worktree. (The live cycle
 * already runs this between iterations via the reviewer quality-gate; the
 * bench re-runs it post-run as ground truth for the rubric's gate-1.)
 */
export function runQualityGate(worktreePath: string, cmd: string[]): boolean {
  if (cmd.length === 0) {
    throw new Error('quality_gate_cmd must have at least one argv element');
  }
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstruct cost / duration / tool-use / outcome from the orchestrator's
 * durable event log. The real `runReviewer` returns only a `ReviewerOutcome`
 * (telemetry goes to the JSONL log, per ADR-008); the bench reads the final
 * `review-loop`/`reviewer` `end`|`error` event the same way the e2e bench's
 * `reconstructGateStateFromEventLog` does.
 */
function reconstructFromEventLog(logPath: string): {
  costUsd: number;
  durationMs: number;
  toolUseSummary: ReviewerToolUseSummary;
  outcome?: string;
} {
  const toolUseSummary: ReviewerToolUseSummary = {
    brainReads: 0,
    writes: 0,
    bashCalls: 0,
    recorderInvocations: 0,
  };
  let costUsd = 0;
  let durationMs = 0;
  let outcome: string | undefined;
  let text: string;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return { costUsd, durationMs, toolUseSummary };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evt: {
      phase?: string;
      skill?: string;
      event_type?: string;
      cost_usd?: number;
      duration_ms?: number;
      metadata?: Record<string, unknown>;
    };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.phase !== 'review-loop' || evt.skill !== 'reviewer') continue;
    if (evt.event_type !== 'end' && evt.event_type !== 'error') continue;
    if (typeof evt.cost_usd === 'number') costUsd = evt.cost_usd;
    if (typeof evt.duration_ms === 'number') durationMs = evt.duration_ms;
    const md = evt.metadata ?? {};
    if (typeof md.outcome === 'string') outcome = md.outcome;
    const tu = md.tool_use as Partial<ReviewerToolUseSummary> | undefined;
    if (tu && typeof tu === 'object') {
      toolUseSummary.brainReads = tu.brainReads ?? toolUseSummary.brainReads;
      toolUseSummary.writes = tu.writes ?? toolUseSummary.writes;
      toolUseSummary.bashCalls = tu.bashCalls ?? toolUseSummary.bashCalls;
      toolUseSummary.recorderInvocations =
        tu.recorderInvocations ?? toolUseSummary.recorderInvocations;
    }
  }
  return { costUsd, durationMs, toolUseSummary, outcome };
}

/**
 * Run one review-loop fixture through the **real** `runReviewer`
 * (orchestrator/phases/reviewer.ts) — the same review-Ralph + verdict-gate +
 * PR-open/merge path the live cycle runs. `getVerdict` is intentionally
 * omitted so the real `defaultGetVerdict` (approve after iteration 1) drives
 * the stage-1-only per-phase bench, exactly as documented in `reviewer.ts`.
 *
 * Returns telemetry reconstructed from the durable event log; the rubric
 * (`scoring.ts:caseScore`) scores the demo bundle + PR description left in
 * the worktree.
 */
export async function runReviewer(input: RunReviewerInput): Promise<RunReviewerResult> {
  let tempdir: string;
  try {
    tempdir = setupTempdir(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tempdir: '',
      worktreePath: '',
      manifestRelPath: '',
      worktreeRelPath: '',
      workItems: [],
      durationMs: 0,
      costUsd: 0,
      toolUseSummary: { brainReads: 0, writes: 0, bashCalls: 0, recorderInvocations: 0 },
      qualityGatesPassed: false,
      runnerError: {
        kind: msg.includes('manifest') ? 'manifest_missing' : 'seed_missing',
        message: msg,
      },
    };
  }

  const worktreePath = resolve(tempdir, 'projects', input.projectName);
  const queueManifestPath = resolve(tempdir, '_queue', 'in-flight', `${input.initiativeId}.md`);
  const manifestRelPath = `_queue/in-flight/${input.initiativeId}.md`;
  const worktreeRelPath = `projects/${input.projectName}`;
  const workItemsDir = resolve(worktreePath, '.forge', 'work-items');

  // Validate the seed's work items up-front (the rubric needs them; a bad
  // seed is a bench-config error, not a reviewer failure). The real
  // `runReviewer` reads them itself too — this is the bench's own ground
  // truth for `caseScore`.
  let workItems: WorkItem[] = [];
  try {
    const { items, parseErrors } = readWorkItemsFromDir(workItemsDir);
    const errorEntries = Object.entries(parseErrors);
    if (errorEntries.length > 0 || items.length === 0) {
      return {
        tempdir,
        worktreePath,
        manifestRelPath,
        worktreeRelPath,
        workItems: [],
        durationMs: 0,
        costUsd: 0,
        toolUseSummary: { brainReads: 0, writes: 0, bashCalls: 0, recorderInvocations: 0 },
        qualityGatesPassed: false,
        runnerError: {
          kind: 'work_items_unreadable',
          message:
            errorEntries.length > 0
              ? errorEntries.map(([p, m]) => `${p}: ${m}`).join('; ')
              : `no work items found at ${workItemsDir}`,
        },
      };
    }
    workItems = items;
  } catch (err) {
    return {
      tempdir,
      worktreePath,
      manifestRelPath,
      worktreeRelPath,
      workItems: [],
      durationMs: 0,
      costUsd: 0,
      toolUseSummary: { brainReads: 0, writes: 0, bashCalls: 0, recorderInvocations: 0 },
      qualityGatesPassed: false,
      runnerError: {
        kind: 'work_items_unreadable',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Point the orchestrator's gh / vhs / npx calls at our shims for the
  // duration of the run, then restore.
  const originalPath = process.env.PATH ?? '';
  const originalGhToken = process.env.GH_TOKEN;
  process.env.PATH = `${resolve(tempdir, 'bin')}:${originalPath}`;
  process.env.GH_TOKEN = 'invalid';

  // Real per-cycle event logger (the reviewer phase emits its telemetry here;
  // we reconstruct cost/duration/tool-use/outcome from it afterwards).
  const cycleId = `bench-review_${input.fixtureId}_${Date.now()}`;
  const logger = createLogger(cycleId, resolve(tempdir, '_logs'));

  // getVerdict omitted on purpose → real `defaultGetVerdict` (stage-1 approve
  // after iteration 1). reviewIterationCap default 3 (1 prep + 2 send-back),
  // but with auto-approve the loop terminates after the prep iteration.
  const cycleInput: CycleInput = {
    initiativeId: input.initiativeId,
    manifestPath: queueManifestPath,
    projectRepoPath: worktreePath,
    worktreePath,
    qualityGateCmd: input.qualityGateCmd,
    reviewIterationCap: input.reviewIterationCap ?? 3,
    reviewIterationBudgetUsd: input.reviewIterationBudgetUsd ?? 0.6,
  };

  let cycleThrew: { kind: ReviewerRunnerErrorKind; message: string } | undefined;
  try {
    await runReviewerPhase(cycleInput, logger);
  } catch (err) {
    cycleThrew = {
      kind: 'cycle_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    process.env.PATH = originalPath;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
  }

  const { costUsd, durationMs, toolUseSummary, outcome } = reconstructFromEventLog(
    logger.logFilePath,
  );

  // Orchestrator-verified ground truth for the rubric's gate-1 (never trust
  // the agent's claim). Re-run the quality gate against the post-run tree.
  const qualityGatesPassed = runQualityGate(worktreePath, input.qualityGateCmd);

  return {
    tempdir,
    worktreePath,
    manifestRelPath,
    worktreeRelPath,
    workItems,
    durationMs,
    costUsd,
    toolUseSummary,
    qualityGatesPassed,
    resultSubtype: outcome,
    runnerError: cycleThrew,
  };
}
