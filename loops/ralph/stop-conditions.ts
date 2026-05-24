/**
 * Stop conditions for the Ralph loop. The loop exits when any one fires.
 *
 * Each condition is a pure function over loop state. Wedged-detector and
 * quality-gates each shell out to side effects (file diff, test runner) but
 * report a boolean.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type StopCondition =
  | { kind: 'quality-gates-pass' }
  | { kind: 'iteration-budget'; max: number }
  | { kind: 'cost-budget'; maxUsd: number }
  | { kind: 'wedged'; noProgressIterations: number }
  // 2026-05-24 (claude-harness cycle 1 audit): synthetic condition the
  // runner emits on iter-0 if the gate passes BEFORE any agent work.
  // Means the WI's quality_gate_cmd doesn't exercise its acceptance
  // criteria — PM must rewrite the gate. Distinct from `wedged` (which
  // is mid-loop no-progress); this fires before any iter has run.
  | { kind: 'gate-too-loose'; reason: string };

export type LoopState = {
  worktreePath: string;
  iteration: number;
  costUsdSoFar: number;
  fixPlanItemsHistory: number[]; // length-of-fix_plan checklist per iteration
  filesChangedHistory: string[][]; // files changed per iteration
};

export type StopResult =
  | { stop: false }
  | { stop: true; reason: string; condition: StopCondition['kind'] };

export async function checkStopConditions(
  state: LoopState,
  conditions: StopCondition[],
  qualityGates: () => boolean | Promise<boolean>,
): Promise<StopResult> {
  for (const condition of conditions) {
    const result = await checkOne(state, condition, qualityGates);
    if (result.stop) return result;
  }
  return { stop: false };
}

async function checkOne(
  state: LoopState,
  condition: StopCondition,
  qualityGates: () => boolean | Promise<boolean>,
): Promise<StopResult> {
  switch (condition.kind) {
    case 'quality-gates-pass':
      if (await qualityGates()) {
        return { stop: true, reason: 'quality gates pass', condition: 'quality-gates-pass' };
      }
      return { stop: false };

    case 'iteration-budget':
      if (state.iteration >= condition.max) {
        return {
          stop: true,
          reason: `iteration budget exhausted (${condition.max})`,
          condition: 'iteration-budget',
        };
      }
      return { stop: false };

    case 'cost-budget':
      if (state.costUsdSoFar >= condition.maxUsd) {
        return {
          stop: true,
          reason: `cost budget exhausted ($${condition.maxUsd})`,
          condition: 'cost-budget',
        };
      }
      return { stop: false };

    case 'wedged': {
      const window = state.fixPlanItemsHistory.slice(-condition.noProgressIterations);
      if (window.length < condition.noProgressIterations) return { stop: false };
      const filesWindow = state.filesChangedHistory.slice(-condition.noProgressIterations);
      const noFixPlanProgress = window.every((n) => n === window[0]);
      const noFileChange = filesWindow.every((files) => files.length === 0);
      if (noFixPlanProgress && noFileChange) {
        return {
          stop: true,
          reason: `wedged: no progress for ${condition.noProgressIterations} iterations`,
          condition: 'wedged',
        };
      }
      return { stop: false };
    }

    case 'gate-too-loose':
      // This condition is never CHECKED in the per-iteration loop — the
      // runner detects it inline at iter 0 (gate passes before any work)
      // and synthesises a finalize() call. The case exists only for
      // discriminated-union exhaustiveness.
      return { stop: false };
  }
}

/**
 * F-23: gate-run telemetry. Populated by the wrapped gate functions and
 * delivered via the optional `onRun` callback so callers can emit a `gate`
 * event with stdout/stderr context (instead of just the boolean pass/fail).
 */
export type GateRunInfo = {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** Last 4 KB of stdout. Empty if the gate produced none. */
  stdoutTail: string;
  /** Last 4 KB of stderr. Empty if the gate produced none. */
  stderrTail: string;
  /** The command that was run, for grep-ability in the event log. */
  command: string;
  /**
   * Set when the gate failed despite exit 0 — surfaces *which* tightening
   * rejected the run. Empty when the gate's outcome was determined by exit
   * code alone (the pre-tightening behaviour).
   */
  rejectReason?: 'no-work-indicator' | 'required-paths-missing';
};

const GATE_OUTPUT_MAX = 4096;

/**
 * Strings that, when present in gate stdout/stderr, indicate **the test
 * runner exited 0 without actually running any tests**. Catches the
 * classic false-pass surfaced by the 2026-05-23 betterado dogfood — see
 * [[quality-gate-cmd-must-assert-new-work]].
 *
 * Match is case-insensitive substring. Lines added here MUST be specific
 * enough that they can't appear in legitimate passing output.
 */
const NO_WORK_INDICATORS: readonly string[] = [
  '[no tests to run]',     // go test (with -run filter that matches nothing)
  'no tests to run',       // go test (other forms)
  'no test files found',   // vitest / jest (matchPattern misses)
  'no tests ran',          // pytest (`pytest tests/` with empty collection)
  'running 0 tests',       // cargo test (no #[test] in scope)
  'collected 0 items',     // pytest verbose summary
  '0 passing, 0 failing',  // mocha (no specs matched)
  'no specs found',        // jasmine
];

/**
 * Tightening options for `makeQualityGateFromCmd`. When all are absent the
 * gate's pass/fail is the exit-code alone (pre-tightening behaviour); when
 * present each layer adds a fail-closed check on top of exit 0.
 */
export type GateTighteningOptions = {
  /**
   * Paths the WI is declared to produce (`creates` per C5) or that the dev-loop
   * must verify exist post-gate (`verification_artifact` per C5). When set,
   * the gate is treated as passed only if `git diff --name-only main...HEAD`
   * (run in the worktree) lists at least one of these paths. Empty array
   * disables the check.
   */
  requiredPaths?: readonly string[];
  /**
   * Override the default no-work-indicator scan with a project-specific set.
   * `null` disables the check entirely (e.g. for projects whose runners
   * print legitimately matching substrings on PASS).
   */
  noWorkIndicators?: readonly string[] | null;
};

/** Default quality-gates implementation: shells to `npm test` in the worktree. */
export function defaultQualityGates(
  worktreePath: string,
  onRun?: (info: GateRunInfo) => void,
): boolean {
  return runGateCapturing(worktreePath, ['sh', '-c', 'npm test --silent'], onRun);
}

/**
 * Build a quality-gate closure from an explicit command vector. Used by
 * cycle.ts:runDeveloperLoop to thread the manifest's per-project
 * `quality_gate_cmd` (Python pytest, bash bats, Rust cargo, etc.) into the
 * Ralph runner — eliminating the F-04 hardcoded `npm test` problem.
 *
 * Returns a sync closure suitable for `LoopInput.qualityGate`. Returns true
 * iff the command exits 0 **and** any tightening checks pass — the
 * dogfood-driven `NO_WORK_INDICATORS` scan + an optional `requiredPaths`
 * git-diff inclusion check (see [[quality-gate-cmd-must-assert-new-work]]).
 *
 * F-23: optional `onRun` callback receives stdout/stderr/exit + reject
 * reason after each invocation so the orchestrator can emit a `gate` event
 * with full context (not just the boolean pass/fail).
 */
export function makeQualityGateFromCmd(
  worktreePath: string,
  cmd: readonly string[],
  onRun?: (info: GateRunInfo) => void,
  options?: GateTighteningOptions,
): () => boolean {
  return () => runGateCapturing(worktreePath, cmd, onRun, options);
}

/**
 * Shared gate-runner: capture stdout/stderr/exit + duration, deliver them via
 * the optional callback, return the boolean the runner expects.
 *
 * Tightening layered on top of exit-0:
 *  1. Scan output for `NO_WORK_INDICATORS` — e.g. `go test` exits 0 with
 *     "[no tests to run]" when `-run TestX` matches nothing. Catches the
 *     2026-05-23 betterado dogfood pattern.
 *  2. If `requiredPaths` supplied, run `git diff --name-only main...HEAD`
 *     in the worktree and require ≥1 of those paths in the diff. Catches
 *     "agent wrote nothing the manifest declared as `creates` /
 *     `verification_artifact`".
 *
 * Either rejection sets `passed: false` + a `rejectReason` on the
 * GateRunInfo so post-mortems can see which layer caught it.
 */
function runGateCapturing(
  worktreePath: string,
  cmd: readonly string[],
  onRun: ((info: GateRunInfo) => void) | undefined,
  options?: GateTighteningOptions,
): boolean {
  if (cmd.length === 0) {
    onRun?.({ passed: false, exitCode: -1, durationMs: 0, stdoutTail: '', stderrTail: '', command: '' });
    return false;
  }
  const [head, ...rest] = cmd;
  if (!head) {
    onRun?.({ passed: false, exitCode: -1, durationMs: 0, stdoutTail: '', stderrTail: '', command: '' });
    return false;
  }
  const command = cmd.join(' ');
  const startedAt = Date.now();
  let passed = false;
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    const out = execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
    stdout = out.toString('utf8');
    passed = true;
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    exitCode = typeof e.status === 'number' ? e.status : 1;
    if (e.stdout) stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8');
    if (e.stderr) stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr.toString('utf8');
    passed = false;
  }

  // Tightening: only relevant when exit-code already said "pass". A non-zero
  // exit is a clear fail regardless of indicators / paths.
  let rejectReason: GateRunInfo['rejectReason'];
  if (passed) {
    // 1. No-work indicator scan.
    const indicators =
      options?.noWorkIndicators === null
        ? []
        : options?.noWorkIndicators ?? NO_WORK_INDICATORS;
    if (indicators.length > 0) {
      const combined = (stdout + ' ' + stderr).toLowerCase();
      for (const ind of indicators) {
        if (combined.includes(ind.toLowerCase())) {
          passed = false;
          exitCode = -2; // synthetic — distinguishes tightening rejection from a real non-zero exit
          rejectReason = 'no-work-indicator';
          // F1.I2 prescriptive: tell the agent WHAT TO DO, not just what failed.
          stderr =
            stderr +
            (stderr.endsWith('\n') ? '' : '\n') +
            `[forge gate-tightening] REJECTED: gate exited 0 but stdout/stderr contains no-work indicator "${ind}". The test runner found no tests to execute.\n` +
            `  ACTION REQUIRED before exiting this iteration: write at least one test that actually runs against the code you just changed (or the code declared in files_in_scope). A test that runs and asserts on real behaviour — not a placeholder. Do NOT exit until the gate sees executed tests.`;
          break;
        }
      }
    }

    // 2. requiredPaths diff inclusion check (skipped if step 1 already rejected).
    if (passed && options?.requiredPaths && options.requiredPaths.length > 0) {
      const diffPaths = gitDiffPathsAgainstMain(worktreePath);
      const matched = options.requiredPaths.some((p) => diffPaths.has(p));
      if (!matched) {
        passed = false;
        exitCode = -3;
        rejectReason = 'required-paths-missing';
        // F1.I2 prescriptive: agent now reads exactly which file to create.
        const required = options.requiredPaths;
        const pathBullets = required.map((p) => `    - ${p}`).join('\n');
        stderr =
          stderr +
          (stderr.endsWith('\n') ? '' : '\n') +
          `[forge gate-tightening] REJECTED: 'git diff --name-only main...HEAD' shows NONE of this work item's required output paths.\n` +
          `  ACTION REQUIRED before exiting this iteration — create AT LEAST ONE of these files in the worktree, then re-run the gate:\n` +
          pathBullets + '\n' +
          `  A compiling stub satisfies the path requirement; the substantive test/code body comes second. Without one of these paths in your diff, the iteration WILL fail. Do not exit until at least one is present in 'git diff'.`;
      }
    }
  }

  onRun?.({
    passed,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: tail(stdout, GATE_OUTPUT_MAX),
    stderrTail: tail(stderr, GATE_OUTPUT_MAX),
    command,
    ...(rejectReason ? { rejectReason } : {}),
  });
  return passed;
}

/**
 * Auto-commit any uncommitted (staged or unstaged) changes in the worktree
 * with a clearly-marked `forge-autocommit` message. Surfaced as a safety
 * net after each agent iteration so the gate's `git diff --name-only
 * main...HEAD` check sees the work even when the agent (Sonnet/Opus)
 * "forgot" to commit despite the system-prompt instruction to do so.
 *
 * Background — surfaced by claude-harness cycle 1 (2026-05-24): the dev
 * agent wrote src/events.ts + tests/events.test.ts (15 tests passed) but
 * never ran `git commit`. The gate then required-paths-rejected for 5
 * iterations because the working-tree files weren't in the branch's
 * commit diff. Auto-committing here keeps the loop from dead-ending on
 * what is otherwise a complete WI.
 *
 * `forge-autocommit:` prefix lets reflectors trivially distinguish these
 * from agent-authored commits in cycle-recap.
 *
 * Returns true if a commit was created; false if there was nothing to
 * commit OR git failed (e.g., no identity). Failures are non-fatal —
 * the gate's normal check runs whether we committed or not.
 */
export function autoCommitWorktreeIfDirty(
  worktreePath: string,
  iteration: number,
  workItemId?: string,
): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, stdio: 'pipe' }).toString('utf8');
    if (status.trim().length === 0) return false;
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: 'pipe' });
    const wiTag = workItemId ? ` ${workItemId}` : '';
    const msg = `forge-autocommit:${wiTag} iter ${iteration} WIP (safety-net for missed agent commit)`;
    execFileSync('git', ['commit', '-m', msg, '--no-verify'], { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the set of paths different on this branch vs the merge base with
 * `main`. Used by the requiredPaths tightening; failures (no git, no main,
 * etc.) return an empty set so the tightening fails-closed only when paths
 * are present-and-required but absent.
 */
function gitDiffPathsAgainstMain(worktreePath: string): Set<string> {
  try {
    const baseBranch = resolveBaseBranch(worktreePath);
    const out = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    const lines = out.toString('utf8').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    return new Set(lines);
  } catch {
    // No git repo / no main+master / detached HEAD: caller's tightening intent is
    // "fail on missing paths"; an empty set causes the .some() check above
    // to fail and reject the gate. That's the safe default — better to
    // false-reject in a degraded git state than to false-pass.
    return new Set();
  }
}

/**
 * Resolve the project's base branch name. Prefers `main`; falls back to
 * `master`. Surfaced by claude-harness cycle 1 (2026-05-24): a fresh
 * `git init` defaults to `master`, but the gate hard-coded `main`, so
 * the diff silently returned empty for 5 iterations even though the
 * agent's commits were on the branch. Throws if neither exists so the
 * caller's catch logs the degraded state.
 */
function resolveBaseBranch(worktreePath: string): string {
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', candidate], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error('no main or master branch in worktree');
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}

/** Read the fix_plan checklist count (number of unchecked items). */
export function countOpenFixPlanItems(worktreePath: string): number {
  const path = join(worktreePath, 'fix_plan.md');
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, 'utf8');
  const matches = content.match(/^- \[ \]/gm);
  return matches?.length ?? 0;
}
