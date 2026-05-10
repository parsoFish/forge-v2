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
  /**
   * F-32: noop-completion guard. Fires when the agent has run ≥ `minIterations`
   * iterations on a WI that declared files_in_scope, but has produced zero
   * "useful writes" (every file in `filesChangedHistory` is a scratch path —
   * AGENT.md, PROMPT.md, fix_plan.md, or anywhere under .forge/). Catches the
   * failure mode where quality-gates-pass fires after a no-op iteration
   * (build is unbroken because the agent didn't touch anything) and the WI
   * gets marked complete despite zero engagement.
   *
   * Ordered BEFORE `quality-gates-pass` in the runner so it shorts the loop
   * out before the trivial-pass exit can fire.
   *
   * - `minIterations`: how many full iterations to allow before declaring noop
   *   (default 1: if iter 1 runs and writes nothing, fail; some WIs that
   *   genuinely need a planning iteration would set this to 2).
   * - `scratchPaths`: substrings; any filesChanged path containing one of
   *   these is ignored when counting useful writes. Defaults applied by the
   *   runner cover the well-known scratch files.
   */
  | { kind: 'noop-completion'; minIterations: number; scratchPaths: string[] };

export type LoopState = {
  worktreePath: string;
  iteration: number;
  costUsdSoFar: number;
  fixPlanItemsHistory: number[]; // length-of-fix_plan checklist per iteration
  filesChangedHistory: string[][]; // files changed per iteration
  /**
   * F-32: WI's declared `files_in_scope` (relative paths). Empty / undefined
   * means the WI has no expected file outputs (e.g., a verification-only WI),
   * which disables the noop-completion check. The runner threads this through
   * from the WI manifest at iteration 0.
   */
  filesInScope?: string[];
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

    case 'noop-completion': {
      // Only meaningful for WIs that declared expected file outputs.
      if (!state.filesInScope || state.filesInScope.length === 0) return { stop: false };
      // Wait until the agent has had at least `minIterations` full passes.
      if (state.iteration < condition.minIterations) return { stop: false };
      // "Useful writes" = filesChanged paths that aren't in scratchPaths.
      const allChanged = state.filesChangedHistory.flat();
      const scratch = condition.scratchPaths;
      const useful = allChanged.filter(
        (p) => !scratch.some((s) => p.includes(s)),
      );
      if (useful.length === 0) {
        return {
          stop: true,
          reason: `noop-completion: ${condition.minIterations} iteration(s) produced 0 useful writes (only scratch files touched)`,
          condition: 'noop-completion',
        };
      }
      return { stop: false };
    }
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
};

const GATE_OUTPUT_MAX = 4096;

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
 * iff the command exits 0 in the worktree.
 *
 * F-23: optional `onRun` callback receives stdout/stderr/exit details after
 * each invocation so the orchestrator can emit a `gate` event with context.
 */
export function makeQualityGateFromCmd(
  worktreePath: string,
  cmd: readonly string[],
  onRun?: (info: GateRunInfo) => void,
): () => boolean {
  return () => runGateCapturing(worktreePath, cmd, onRun);
}

/**
 * Shared gate-runner: capture stdout/stderr/exit + duration, deliver them via
 * the optional callback, return the boolean the runner expects.
 */
function runGateCapturing(
  worktreePath: string,
  cmd: readonly string[],
  onRun: ((info: GateRunInfo) => void) | undefined,
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
  onRun?.({
    passed,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: tail(stdout, GATE_OUTPUT_MAX),
    stderrTail: tail(stderr, GATE_OUTPUT_MAX),
    command,
  });
  return passed;
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
