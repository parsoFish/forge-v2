/**
 * Chained-bench sequencer. A **thin** wrapper that turns one SEED (an
 * architect-level prompt — the same shape as a
 * `benchmarks/architect/prompts.json` entry) into one generated artifact set
 * by running the real product path, then hands those artifacts to the
 * EXISTING per-phase pure `scoring.ts:caseScore` functions (in
 * `benchmarks/chained/score.ts`).
 *
 * This module owns NO fixtures and NO rubric. Adding an e2e case = adding a
 * seed, never a rubric or a fixture (brain theme `chained-phase-benchmarks`,
 * US-6.2). The chain IS the existing per-phase benchmarks wired in sequence:
 *
 *   Step 0  architect bench (benchmarks/architect/sdk.ts) ── seed → manifest
 *   cpSync  manifest: _queue/pending/ → _queue/in-flight/
 *   Steps 1-5  the real orchestrator/cycle.ts:runCycle
 *              (PM → developer-loop → review-Ralph → merge → reflection)
 *
 * `runCycle` is the sequencing ENGINE (the real product path) — it
 * contributes no rubric. All scoring is the existing per-phase rubrics over
 * the generated artifacts; a chain break at phase N is simply phase N's
 * existing bench failing on phase N-1's output.
 *
 * Brain-pollution fix (spec §C blocker): the real `runReflector`
 * (orchestrator/phases/reflector.ts) computes `forgeRoot` from its own module
 * path and writes themes to the LIVE `brain/projects/<project>/themes/` +
 * `brain/_raw/cycles/`. We cannot change orchestrator runtime. So the
 * sequencer (a) builds a masked tempdir brain via the lifted
 * `_lib/brain-mask.ts:layerBrain`, then (b) for the duration of `runCycle`
 * only, swaps the live brain's two mutable subtrees (+ log.md) for symlinks
 * into that masked tempdir, restoring the originals in a `finally`. The
 * reflector's absolute-path writes follow the symlink into the tempdir; the
 * reflection `caseScore` reads the tempdir; the live brain is byte-identical
 * after the run. This is bench plumbing, not an orchestrator change.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCycle, type CycleInput, type CycleResult } from '../../orchestrator/cycle.ts';
import { confirmPrMerged } from '../../orchestrator/pr.ts';
import { parseManifest } from '../../orchestrator/manifest.ts';
import { getPaths } from '../../orchestrator/queue.ts';
import { layerBrain } from '../_lib/brain-mask.ts';
import { runCycleWithBoundedRetry } from '../_lib/chained-retry.ts';
import {
  buildGhShimScript,
  forgeSnapshotDir,
  readGhMetadata,
  writeShim,
} from '../_lib/gh-shim.ts';
import {
  VHS_SHIM_SCRIPT,
  NPX_PLAYWRIGHT_SHIM_SCRIPT,
} from '../_lib/recorder-shims.ts';
import { runArchitect, type RunArchitectResult } from '../architect/sdk.ts';
import { simulatorVerdict, runSpecChecks, type TargetSpec } from '../e2e/simulator.ts';
import {
  bridgeMovedManifestForReflector,
  removeReflectorManifestBridge,
  type ReflectorManifestBridge,
} from './reflector-manifest-bridge.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * The reflector's stage-3 operator feedback. The 3rd human moment: in
 * production a human writes `_logs/<cycle-id>/user-feedback.md` (via
 * `/forge-reflect <id>`) before the next cycle; the reflector reads it
 * for retro Sections 2 + 3. In the chained bench there is no operator, so
 * the harness pre-writes this canned, minimal-but-realistic payload —
 * exactly mirroring how `benchmarks/reflection/` simulates the same
 * handoff (a short `## Answers` block + a `## Free-form` paragraph). This
 * is a legitimately-absent human in a bench, faithfully stubbed.
 */
const CANNED_USER_FEEDBACK = `# User feedback — chained bench

## Answers

> _Answers to the questions the reflector wrote in \`user-questions.md\`.
> The chained bench has no live operator; this is the canned stand-in._

- The cycle ran end-to-end (architect → PM → dev-loop → review → merge).
  Treat a single PM re-run, if it happened, as the expected stochastic
  recovery — not a defect; the bounded auto-retry is working as designed.
- Nothing here needs escalation. Capture the run as a healthy
  reference cycle for this seed.

## Free-form

No surprises on the dev or review side. The bounded-retry mirror means
the chained bench now exercises the same self-heal path production does.
`;

/**
 * Where the reflector phase reads/writes its cycle artefacts. The
 * reflector resolves `cycleLogDir` module-relative to the REAL forge root
 * (`resolve(import.meta.dirname, '../..')` in
 * `orchestrator/phases/reflector.ts`), NOT cwd — so even though the
 * chained harness `chdir`s into the tempdir, the reflector reads
 * `<realforge>/_logs/<cycleId>/user-feedback.md`. The harness pre-writes
 * there and cleans it up afterwards (mirroring the brain-mask "leave no
 * residue" discipline).
 */
function realForgeCycleLogDir(cycleId: string): string {
  return resolve(FORGE_ROOT, '_logs', cycleId);
}

/**
 * Pre-populate the reflector's stage-3 feedback file BEFORE the cycle
 * runs (the reflector phase only reads it; it never overwrites an
 * existing file). Idempotent. Mirrors
 * `benchmarks/reflection/simulator.ts:prepareUserFeedback`.
 */
export function prewriteCannedUserFeedback(cycleId: string): string {
  const dir = realForgeCycleLogDir(cycleId);
  mkdirSync(dir, { recursive: true });
  const feedbackPath = resolve(dir, 'user-feedback.md');
  writeFileSync(feedbackPath, CANNED_USER_FEEDBACK);
  return feedbackPath;
}

/**
 * One chain seed. Mirrors a `benchmarks/architect/prompts.json` entry
 * (`user_prompt` + `project` + feature-count expectations) PLUS the
 * downstream pieces the cycle needs that the architect doesn't author: a
 * seed worktree for the project and a target spec the in-cycle simulator
 * grounds its verdict in. The architect prompt is the ONLY "e2e test input".
 */
export type ChainSeed = {
  id: string;
  /** Architect-level intent (same shape as architect prompts.json `user_prompt`). */
  architectPrompt: string;
  /** Project name. The architect names the manifest's `project`; this must match. */
  project: string;
  /** Feature-count band passed to the architect bench. */
  architectExpected: { min_features: number; max_features: number };
  /** Optional pre-populated `projects/<project>/roadmap.md` for the architect. */
  projectContext?: string;
  /** Absolute path to the seed worktree (initial `main` of the project repo). */
  seedTreePath: string;
  /** Target spec the in-cycle human-simulator grounds its verdict in. */
  spec: TargetSpec;
  /** Quality-gate argv. Defaults to inferred (npm test if package.json else true). */
  qualityGateCmd?: string[];
  /** Review-Ralph iteration cap. Default 3 (1 prep + 2 send-back). */
  reviewIterationCap?: number;
  /** Per-iteration USD budget for the review-Ralph. Default 1.0. */
  reviewIterationBudgetUsd?: number;
};

export type ChainStepError = { step: string; kind: string; message: string };

/**
 * The generated artifact set, with the locations each per-phase `caseScore`
 * needs. `score.ts` fans these out to the six existing rubrics — no new
 * scoring lives here.
 */
export type ChainArtifacts = {
  tempdir: string;
  /** Generated manifest (architect output, copied into the queue). */
  manifestPath: string | null;
  manifestText: string | null;
  /** Parsed initiative_id from the generated manifest (null if none). */
  initiativeId: string | null;
  /** `<tempdir>/projects/<project>/.forge/work-items/` (PM output). */
  workItemsDir: string;
  /** `<tempdir>/projects/<project>` (the merged worktree). */
  worktreePath: string;
  /** Durable JSONL event log written by `runCycle`. */
  eventLogPath: string | null;
  /**
   * Where review/reflection artifacts can be read from. The pre-merge
   * gh-shim snapshot of `.forge/` survives `git clean`; the rubric falls
   * back to the worktree `.forge/` if no snapshot exists.
   */
  forgeSnapshotDir: string;
  /** Masked tempdir brain root (reflection `caseScore` benchRoot). */
  benchRoot: string;
  /** `<benchRoot>/brain/projects/<project>/themes/` (masked; reflector wrote here). */
  themesDir: string;
  cycleResult: CycleResult | null;
  /** Did the gh shim record a merge? */
  merged: boolean;
  /** First fatal step error, if the chain broke before producing artifacts. */
  chainError: ChainStepError | null;
};

/**
 * Set up the chained tempdir: a forge-root mirror the orchestrator can run
 * inside. Same shape the (deleted) e2e setup used, plus the masked brain.
 *
 *   <tempdir>/
 *     skills/ docs/ orchestrator/ loops/   (read-only symlinks)
 *     brain/                                (layerBrain: masked, writable
 *                                            project themes/ + _raw/cycles/)
 *     projects/<project>/                   (seed → real git repo:
 *                                              main = seed, initiative-<id>)
 *     _queue/{pending,in-flight,ready-for-review,done,failed}/
 *     bin/{gh,vhs,npx}                      (PATH shims; gh = smart _lib shim)
 *     _pr-metadata.json                     (gh shim records PR state)
 *     _forge-snapshot/                      (gh shim pre-merge .forge/ copy)
 */
export function setupChainedTempdir(seed: ChainSeed): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-chained-'));

  for (const sub of ['skills', 'docs', 'orchestrator', 'loops']) {
    symlinkSync(resolve(FORGE_ROOT, sub), resolve(dir, sub));
  }

  // Masked brain (writable target-project themes/ + _raw/cycles/).
  layerBrain(dir, seed.project);

  // Seed worktree → projects/<project>/, as a real git repo.
  if (!existsSync(seed.seedTreePath)) {
    throw new Error(`seed tree path does not exist: ${seed.seedTreePath}`);
  }
  const projDir = resolve(dir, 'projects', seed.project);
  mkdirSync(projDir, { recursive: true });
  cpSync(seed.seedTreePath, projDir, { recursive: true });

  for (const q of ['pending', 'in-flight', 'ready-for-review', 'done', 'failed']) {
    mkdirSync(resolve(dir, '_queue', q), { recursive: true });
  }

  // roadmap.md for the architect step (optional).
  if (seed.projectContext !== undefined) {
    writeFileSync(resolve(projDir, 'roadmap.md'), seed.projectContext);
  }

  const binDir = resolve(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  // cleanAfterMerge: true mirrors the realistic merge (strips gitignored
  // Ralph scratch); the pre-merge .forge/ snapshot keeps review/reflection
  // artifacts reachable for the per-phase rubrics.
  writeShim(resolve(binDir, 'gh'), buildGhShimScript(projDir, dir, { cleanAfterMerge: true }));
  writeShim(resolve(binDir, 'vhs'), VHS_SHIM_SCRIPT);
  writeShim(resolve(binDir, 'npx'), NPX_PLAYWRIGHT_SHIM_SCRIPT);

  return dir;
}

function initGitRepo(projDir: string, initiativeId: string): void {
  if (existsSync(resolve(projDir, '.git'))) return;
  const sh = (cmd: string, args: string[], cwd = projDir): void => {
    execFileSync(cmd, args, { cwd, stdio: 'pipe' });
  };
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'bench@forge.local']);
  sh('git', ['config', 'user.name', 'forge bench']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-q', '-m', 'initial commit (bench seed)']);
  // Bare `origin` so the dev-loop's per-WI `pushInitiativeBranch` and the
  // Phase-6 G8 local↔remote invariant (`origin/<branch>` must exist) hold
  // in the harness — same pattern as the e2e/review-loop benches. Without
  // this the full chain aborts at dev-loop close before review/reflection
  // (a real cross-phase gap the chained run is designed to catch).
  const origin = resolve(projDir, '..', '..', '_origin.git');
  sh('git', ['init', '-q', '--bare', origin], resolve(projDir, '..'));
  sh('git', ['remote', 'add', 'origin', origin]);
  sh('git', ['push', '-q', 'origin', 'main']);
  sh('git', ['checkout', '-q', '-b', `initiative-${initiativeId}`]);
}

export function cleanupTempdir(tempdir: string): void {
  // Inspection affordance, same env as the reflection bench
  // (benchmarks/reflection/score.ts): keep the full chained artifact set
  // (generated manifest, WIs, dev-loop commits, PR/demo, retro/themes,
  // events.jsonl, merged worktree) so a run can double as a forge
  // demonstration. Off by default — normal bench runs still clean up.
  if (process.env.FORGE_BENCH_KEEP_TEMPDIR === '1') {
    process.stdout.write(`[chained] kept tempdir: ${tempdir}\n`);
    return;
  }
  try {
    rmSync(tempdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Live-brain mask (in-place symlink swap). The real reflector writes to the
// live brain via an absolute, module-relative path; we cannot change that.
// Around `runCycle` only, redirect the two mutable subtrees (+ log.md) into
// the masked tempdir brain, then restore. try/finally + a restore guard keep
// the live brain byte-identical.
// ---------------------------------------------------------------------------

type BrainMaskHandle = {
  /** [livePath, movedAsidePath | null] pairs to restore in reverse. */
  swaps: Array<{ live: string; stash: string | null; wasSymlink: boolean }>;
  /**
   * Live directories the mask had to create because they did not exist
   * (e.g. `brain/projects/<new-project>/` for a project with no prior
   * themes). `restoreLiveBrain` removes these so a fresh project leaves no
   * residue in the live brain.
   */
  createdDirs: string[];
};

function liveBrainTargets(project: string): string[] {
  return [
    resolve(FORGE_ROOT, 'brain', 'projects', project, 'themes'),
    resolve(FORGE_ROOT, 'brain', '_raw', 'cycles'),
    resolve(FORGE_ROOT, 'brain', 'log.md'),
  ];
}

function maskedCounterpart(tempdir: string, project: string, liveTarget: string): string {
  if (liveTarget.endsWith(`${project}/themes`) || liveTarget.endsWith(`${project}\\themes`)) {
    return resolve(tempdir, 'brain', 'projects', project, 'themes');
  }
  if (liveTarget.endsWith('log.md')) {
    return resolve(tempdir, 'brain', 'log.md');
  }
  return resolve(tempdir, 'brain', '_raw', 'cycles');
}

/**
 * Defensive pre-clean: empty `__chained_test_proj_*` and `__bench_*`
 * directories under `brain/projects/` left by previously-interrupted bench
 * runs. The normal `restoreLiveBrain` removes the parent on success; this
 * sweep covers the case where a previous node process was killed before its
 * `finally` ran. Safe — only deletes EMPTY dirs matching the contamination
 * pattern. See `scripts/brain-scrub-test-contamination.ts` for the
 * standalone scrubber and `docs/planning/2026-05-20-refinement/01-brain.md`
 * §"Cleanup playbook" Tier A.
 */
function preCleanContamination(): void {
  const projectsRoot = resolve(FORGE_ROOT, 'brain', 'projects');
  if (!existsSync(projectsRoot)) return;
  for (const entry of readdirSync(projectsRoot)) {
    if (!/^__(chained_test_proj_|bench_)/.test(entry)) continue;
    const full = resolve(projectsRoot, entry);
    try {
      if (!lstatSync(full).isDirectory()) continue;
      if (readdirSync(full).length !== 0) continue;
      // recursive:true required even for empty dirs — `rm` Node refuses to
      // remove directories without it (EISDIR).
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Move each live target aside and symlink it to its masked tempdir
 * counterpart. Returns a handle for `restoreLiveBrain`.
 *
 * Contamination boundary (per S1.2 plan 01 refinement #3): we pre-clean any
 * empty `__chained_test_proj_*` dirs left by prior interrupted runs before
 * setting up our own.
 */
export function maskLiveBrain(tempdir: string, project: string): BrainMaskHandle {
  preCleanContamination();
  const handle: BrainMaskHandle = { swaps: [], createdDirs: [] };
  for (const live of liveBrainTargets(project)) {
    const masked = maskedCounterpart(tempdir, project, live);
    mkdirSync(resolve(masked, '..'), { recursive: true });
    if (live.endsWith('log.md')) {
      if (!existsSync(masked)) writeFileSync(masked, '');
    } else if (!existsSync(masked)) {
      mkdirSync(masked, { recursive: true });
    }
    // The live target's PARENT must exist before symlinkSync. For a project
    // with no prior brain themes, `brain/projects/<project>/` is absent —
    // create it (and remember, so restore removes it cleanly).
    const liveParent = resolve(live, '..');
    if (!existsSync(liveParent)) {
      mkdirSync(liveParent, { recursive: true });
      handle.createdDirs.push(liveParent);
    }
    let stash: string | null = null;
    const wasSymlink = existsSync(live) && lstatSync(live).isSymbolicLink();
    if (existsSync(live) || wasSymlink) {
      stash = `${live}.chained-stash-${process.pid}`;
      renameSync(live, stash);
    }
    symlinkSync(masked, live);
    handle.swaps.push({ live, stash, wasSymlink });
  }
  return handle;
}

/**
 * Restore the live brain to its pre-mask state. Idempotent and defensive —
 * always called in a `finally`. Removes the redirect symlink and moves the
 * stashed original back.
 */
export function restoreLiveBrain(handle: BrainMaskHandle): void {
  // Reverse order (symmetry; order is independent here but keep it tidy).
  for (const swap of [...handle.swaps].reverse()) {
    try {
      if (existsSync(swap.live) && lstatSync(swap.live).isSymbolicLink()) {
        unlinkSync(swap.live);
      } else if (existsSync(swap.live)) {
        // Unexpected: a real path where our symlink was. Move it out of the
        // way so the stash restore below can put the original back.
        rmSync(swap.live, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (swap.stash && existsSync(swap.stash)) {
      try {
        renameSync(swap.stash, swap.live);
      } catch {
        /* best-effort — leave the stash for manual recovery */
      }
    }
  }
  // Remove any parent dirs the mask created for a brand-new project, but
  // only if now empty (the symlink was removed above; nothing else should
  // have been written into the LIVE parent because writes followed the
  // symlink into the tempdir).
  for (const dir of [...handle.createdDirs].reverse()) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        // recursive:true required for empty directories — Node's rm refuses
        // to remove a directory without it (EISDIR). S1.2 fix: this was the
        // root cause of the 128 contamination dirs in the corpus.
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  }
}

export type RunChainInput = {
  seed: ChainSeed;
  /**
   * Inject the architect-step query (test seam). Defaults to the real SDK in
   * benchmarks/architect/sdk.ts.
   */
  architectQueryFn?: Parameters<typeof runArchitect>[0]['queryFn'];
};

/**
 * Run one chain: architect bench → cpSync → runCycle. Returns the generated
 * artifact set for `score.ts` to fan out to the existing per-phase rubrics.
 * Never throws — chain breaks are surfaced via `ChainArtifacts.chainError`
 * (so the per-phase rubric for the broken phase scores its own zero).
 */
export async function runChain(input: RunChainInput): Promise<ChainArtifacts> {
  const { seed } = input;
  const tempdir = setupChainedTempdir(seed);
  const projDir = resolve(tempdir, 'projects', seed.project);
  const benchRoot = tempdir;

  const base: Omit<ChainArtifacts, 'chainError'> = {
    tempdir,
    manifestPath: null,
    manifestText: null,
    initiativeId: null,
    workItemsDir: resolve(projDir, '.forge', 'work-items'),
    worktreePath: projDir,
    eventLogPath: null,
    forgeSnapshotDir: forgeSnapshotDir(tempdir),
    benchRoot,
    themesDir: resolve(tempdir, 'brain', 'projects', seed.project, 'themes'),
    cycleResult: null,
    merged: false,
  };

  // ---- Step 0: architect bench (seed → manifest) ----
  let arch: RunArchitectResult;
  try {
    arch = await runArchitect({
      fixtureId: seed.id,
      userPrompt: seed.architectPrompt,
      projectName: seed.project,
      projectContext: seed.projectContext,
      expected: seed.architectExpected,
      queryFn: input.architectQueryFn,
    });
  } catch (err) {
    return {
      ...base,
      chainError: {
        step: 'architect',
        kind: 'architect_threw',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (arch.manifestText === null) {
    return {
      ...base,
      chainError: {
        step: 'architect',
        kind: arch.runnerError?.kind ?? 'no_manifest',
        message: arch.runnerError?.message ?? 'architect produced no manifest',
      },
    };
  }

  // Parse the generated manifest for its initiative_id (the architect names
  // it `INIT-<date>-<slug>`). The PM/reviewer key the queue on the filename.
  let initiativeId: string;
  try {
    initiativeId = parseManifest(arch.manifestText).initiative_id;
  } catch (err) {
    return {
      ...base,
      manifestText: arch.manifestText,
      chainError: {
        step: 'architect',
        kind: 'manifest_unparseable',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Write the generated manifest into _queue/pending/, then cpSync
  // pending/ → in-flight/ (the architect→PM seam; the spec's one cpSync).
  const pendingPath = resolve(tempdir, '_queue', 'pending', `${initiativeId}.md`);
  const inFlightPath = resolve(tempdir, '_queue', 'in-flight', `${initiativeId}.md`);
  writeFileSync(pendingPath, arch.manifestText);
  cpSync(pendingPath, inFlightPath);

  // Clean up the architect bench's own tempdir (it ran isolated).
  try {
    rmSync(arch.tempdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  // The project repo becomes a real git repo now (after the architect step,
  // before the cycle) so PM/dev/review run on `initiative-<id>`.
  initGitRepo(projDir, initiativeId);
  // Capture the pre-cycle HEAD on the initiative branch. The bounded-retry
  // wrapper resets the repo to this commit between attempts — the in-place
  // equivalent of the scheduler giving each retry a fresh `git worktree
  // add` of the initiative branch.
  const preCycleHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();

  const withManifest: Omit<ChainArtifacts, 'chainError'> = {
    ...base,
    manifestPath: inFlightPath,
    manifestText: arch.manifestText,
    initiativeId,
  };

  // ---- Steps 1-5: the real runCycle (PM → dev → review → reflect) ----
  const qualityGateCmd =
    seed.qualityGateCmd ??
    (existsSync(resolve(projDir, 'package.json')) ? ['npm', 'test', '--silent'] : ['true']);

  // Deterministic, unique cycle id so the harness can pre-write the
  // reflector's stage-3 `user-feedback.md` BEFORE the cycle runs (the
  // reflector resolves the cycle-log dir module-relative to the real
  // forge root, so the id must be known up-front and collision-free
  // across runs).
  const cycleId = `chained-${initiativeId}-${Date.now()}`;
  const userFeedbackPath = prewriteCannedUserFeedback(cycleId);

  const cycleInput: CycleInput = {
    initiativeId,
    cycleId,
    manifestPath: inFlightPath,
    projectRepoPath: projDir,
    worktreePath: projDir,
    qualityGateCmd,
    reviewIterationCap: seed.reviewIterationCap ?? 3,
    reviewIterationBudgetUsd: seed.reviewIterationBudgetUsd ?? 1.0,
    getVerdict: async (ctx) => {
      const preComputedSpecResults = runSpecChecks(ctx.worktreePath, seed.spec);
      return simulatorVerdict({ ctx, spec: seed.spec, preComputedSpecResults });
    },
    // Phase 6 operator-merge model. The reviewer no longer auto-merges
    // (G9) — it produces the PR and STOPS. The closure step calls this
    // hook to learn whether the operator has merged. In production this
    // defaults to `confirmPrMerged` and is false right after the PR is
    // created (the operator hasn't merged), so the unattended cycle ends
    // at `pr-open`. The chained bench models the operator clicking
    // "merge": it runs `gh pr merge` via the shim (the operator action —
    // bench-side, NOT the orchestrator) then confirms via the same
    // `gh pr view --json state` the production `confirmPrMerged` reads.
    // This keeps the chain exercising closure + reflection end-to-end
    // while `mergePullRequest` stays unreachable from every product path.
    confirmMerge: (worktreePath: string): boolean => {
      try {
        execFileSync('gh', ['pr', 'merge', '--merge'], {
          cwd: worktreePath,
          stdio: 'pipe',
        });
      } catch {
        // No PR / merge conflict → the operator could not merge; closure
        // treats the unconfirmed state as NOT merged (stays pr-open).
        return false;
      }
      return confirmPrMerged(worktreePath);
    },
  };

  const originalCwd = process.cwd();
  const originalPath = process.env.PATH ?? '';
  const originalGhToken = process.env.GH_TOKEN;
  const brainMask = maskLiveBrain(tempdir, seed.project);
  // Wiring bridge (false-red fix): the reflector phase resolves the manifest
  // module-relative to the REAL forge root via
  // `resolveCurrentManifestPath(input.manifestPath, realForgeRoot)`. On a
  // merged cycle closure has moved the manifest into the *tempdir*
  // `_queue/done/` and reflection runs immediately after (same `runCycle`),
  // so that resolution ENOENTs (`reflector.manifest-unreadable`) even though
  // closure succeeded. Mirror the tempdir queue under the real forge root
  // with symlinks (installed BEFORE the cycle; they activate exactly when
  // closure populates the tempdir done/). Same leave-no-residue discipline
  // as the cycle-log / user-feedback bridge below — torn down in `finally`.
  const manifestBridge: ReflectorManifestBridge | null =
    bridgeMovedManifestForReflector({
      tempdir,
      initiativeId,
      inFlightManifestPath: inFlightPath,
      realForgeRoot: FORGE_ROOT,
    });

  let cycleResult: CycleResult | null = null;
  let chainError: ChainStepError | null = null;
  try {
    // Queue moves + cwd-relative resolution must target the tempdir.
    process.chdir(tempdir);
    process.env.PATH = `${resolve(tempdir, 'bin')}:${originalPath}`;
    process.env.GH_TOKEN = 'invalid';
    // Production-faithful bounded auto-retry. `forge serve` never runs a
    // cycle bare — the scheduler wraps every cycle in
    // `dispatchTerminalStatus` → `decideAutoRetry` (cap +
    // anti-thrash, reading the `failure_classification` event `runCycle`
    // wrote). The wrapper REUSES that exact production code as the retry
    // authority and only sequences attempts the way the scheduler's
    // poll loop does (re-claim pending/ → in-flight/, fresh-worktree
    // git reset, re-run). One stochastic PM slip (now
    // `pm-invalid-work-items`, recoverable) therefore self-heals here
    // exactly as it would in prod, instead of aborting the chain.
    const retry = await runCycleWithBoundedRetry({
      cycleInput,
      paths: getPaths(resolve(tempdir, '_queue')),
      filename: `${initiativeId}.md`,
      manifest: { initiativeId, project: seed.project },
      projDir,
      preCycleHead,
      runCycleFn: runCycle,
    });
    cycleResult = retry.result;
  } catch (err) {
    chainError = {
      step: 'cycle',
      kind: 'cycle_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;
    // CRITICAL: always restore the live brain.
    restoreLiveBrain(brainMask);
    // CRITICAL: always remove the reflector manifest bridge symlinks (leave
    // the real forge `_queue/` byte-identical — same discipline as the
    // brain mask).
    removeReflectorManifestBridge(manifestBridge);
    // Wiring bridge (gap fix): the reflector phase resolves its cycle-log
    // dir module-relative to the REAL forge root (it `mkdir`s + writes
    // retro.md / user-questions.md to `<realforge>/_logs/<cycleId>/`),
    // but the reflection `caseScore` reads `<benchRoot>/_logs/<cycleId>/`
    // (benchRoot = tempdir). Without bridging, `retro_emitted` /
    // `retro_structured` always fail on chained even on a perfect run.
    // Copy the reflector's real-forge artefacts into the tempdir
    // `_logs/<cycleId>/` (the event log already lands there — it's
    // cwd-relative via createLogger), then remove the real-forge dir so
    // the run leaves no residue (same discipline as the brain mask).
    try {
      const realCycleLogDir = realForgeCycleLogDir(cycleId);
      if (existsSync(realCycleLogDir)) {
        const tempdirCycleLogDir = resolve(tempdir, '_logs', cycleId);
        mkdirSync(tempdirCycleLogDir, { recursive: true });
        for (const entry of readdirSync(realCycleLogDir)) {
          // Don't clobber the cwd-relative event log already in the
          // tempdir; copy only the reflector's module-relative artefacts.
          if (entry === 'events.jsonl') continue;
          cpSync(
            resolve(realCycleLogDir, entry),
            resolve(tempdirCycleLogDir, entry),
            { recursive: true, force: true },
          );
        }
      }
    } catch {
      /* best-effort — reflection caseScore degrades gracefully if absent */
    }
    if (process.env.FORGE_BENCH_KEEP_TEMPDIR !== '1') {
      try {
        rmSync(realForgeCycleLogDir(cycleId), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    } else {
      process.stdout.write(`[chained] kept reflector feedback: ${userFeedbackPath}\n`);
    }
  }

  const ghMeta = readGhMetadata(tempdir);

  return {
    ...withManifest,
    eventLogPath: cycleResult?.log_path ?? null,
    cycleResult,
    merged: ghMeta?.merged === true,
    chainError,
  };
}
