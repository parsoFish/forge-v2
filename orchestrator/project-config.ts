/**
 * Per-project configuration loader. Implements CONTRACTS.md C1 + C2 + C26 +
 * C27 + C28: each managed project declares its demo shape, quality gate,
 * optional holistic metrics, and optional parameter-sweep plug-in points in
 * `<project-root>/.forge/project.json`.
 *
 * The loader is **fail-closed** per council 04 F8 + plan 04 Open Q4: any
 * malformed file (missing required block, bad shape value, malformed JSON)
 * throws so the scheduler refuses to schedule the initiative. The only
 * non-throwing outcome on parse failure is "file does not exist" — in which
 * case the loader returns `null` and the caller decides whether the absence
 * is acceptable (S4 caller in the live cycle refuses; the bench tests
 * exercise both branches).
 *
 * The schema lives in `docs/schemas/project-config.schema.json`. The loader's
 * hand-rolled validator below is the source of truth for *behavioural*
 * checks (shape enum, preview_command required when browser, etc.); the
 * JSON-schema file is the operator-facing reference.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_CONFIG_REL_PATH = '.forge/project.json';

export type DemoShape = 'browser' | 'harness' | 'cli-diff' | 'artifact' | 'none';

export const DEMO_SHAPES: ReadonlySet<DemoShape> = new Set<DemoShape>([
  'browser',
  'harness',
  'cli-diff',
  'artifact',
  'none',
]);

export type DemoConfig = {
  shape: DemoShape;
  /** Argv-style demo command. Required when shape != 'none'. */
  command?: string[];
  /** Output directory relative to worktree root. Default: `demo/<initiative-id>/`. */
  output?: string;
  /** Git ref / branch the unifier diffs against for before/after captures. Default `main`. */
  baseline?: string;
  /** Required for shape: 'browser' — the dev/preview server command. */
  preview_command?: string[];
};

export type MetricsConfig = {
  /** Argv-style command emitting one or more scalar metrics on stdout. */
  command: string[];
  /** Directory holding locked baseline markdown files. */
  baselines_dir: string;
  /** Allowable percentage drift before flagging regression. */
  tolerance_pct: number;
};

export type SweepConfig = {
  /** Argv-style command that brings the testbed up. */
  start_command: string[];
  /** Path (worktree-relative) to a module exporting a sample-draw function. */
  draw_function: string;
  /** Path (worktree-relative) to a module that parses `metrics.command` output. */
  measurement_extractor: string;
};

export type ProjectConfig = {
  demo: DemoConfig;
  quality_gate_cmd: string[];
  metrics?: MetricsConfig;
  sweep?: SweepConfig;
};

/**
 * Load and validate `<projectRoot>/.forge/project.json`. Returns `null` if
 * the file doesn't exist; throws on any structural / semantic violation
 * (callers depend on the throw to enforce fail-closed scheduling).
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig | null {
  const path = join(projectRoot, PROJECT_CONFIG_REL_PATH);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `project-config: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `project-config: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateProjectConfig(parsed);
}

/**
 * Validate a parsed object as a `ProjectConfig`. Throws on any violation.
 * Exported for use in tests and operator tooling that may consume the
 * config from sources other than the filesystem.
 */
export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('project-config: root must be an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.demo !== 'object' || obj.demo === null) {
    throw new Error('project-config: missing required `demo` block');
  }
  const demoIn = obj.demo as Record<string, unknown>;
  const shape = demoIn.shape;
  if (typeof shape !== 'string' || !DEMO_SHAPES.has(shape as DemoShape)) {
    throw new Error(
      `project-config: demo.shape must be one of ${[...DEMO_SHAPES].join(' | ')} (got ${JSON.stringify(shape)})`,
    );
  }
  const command = optionalArgv(demoIn.command, 'demo.command');
  if (shape !== 'none' && !command) {
    throw new Error(`project-config: demo.command is required when demo.shape != "none"`);
  }
  const preview_command = optionalArgv(demoIn.preview_command, 'demo.preview_command');
  if (shape === 'browser' && !preview_command) {
    throw new Error(
      'project-config: demo.preview_command is required when demo.shape = "browser"',
    );
  }
  const output = optionalString(demoIn.output, 'demo.output');
  const baseline = optionalString(demoIn.baseline, 'demo.baseline');

  const demo: DemoConfig = {
    shape: shape as DemoShape,
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
    ...(baseline ? { baseline } : {}),
    ...(preview_command ? { preview_command } : {}),
  };

  const quality_gate_cmd = optionalArgv(obj.quality_gate_cmd, 'quality_gate_cmd');
  if (!quality_gate_cmd) {
    throw new Error('project-config: missing required `quality_gate_cmd` (argv)');
  }

  const metrics = parseMetrics(obj.metrics);
  const sweep = parseSweep(obj.sweep);

  return {
    demo,
    quality_gate_cmd,
    ...(metrics ? { metrics } : {}),
    ...(sweep ? { sweep } : {}),
  };
}

function parseMetrics(raw: unknown): MetricsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('project-config: metrics must be an object when present');
  }
  const m = raw as Record<string, unknown>;
  const command = optionalArgv(m.command, 'metrics.command');
  if (!command) {
    throw new Error('project-config: metrics.command is required when metrics block is present');
  }
  const baselines_dir = optionalString(m.baselines_dir, 'metrics.baselines_dir');
  if (!baselines_dir) {
    throw new Error('project-config: metrics.baselines_dir is required when metrics block is present');
  }
  const tolerance_pct =
    typeof m.tolerance_pct === 'number' ? m.tolerance_pct : Number.NaN;
  if (!Number.isFinite(tolerance_pct)) {
    throw new Error('project-config: metrics.tolerance_pct must be a finite number');
  }
  return { command, baselines_dir, tolerance_pct };
}

function parseSweep(raw: unknown): SweepConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('project-config: sweep must be an object when present');
  }
  const s = raw as Record<string, unknown>;
  const start_command = optionalArgv(s.start_command, 'sweep.start_command');
  if (!start_command) {
    throw new Error('project-config: sweep.start_command is required when sweep block is present');
  }
  const draw_function = optionalString(s.draw_function, 'sweep.draw_function');
  if (!draw_function) {
    throw new Error('project-config: sweep.draw_function is required when sweep block is present');
  }
  const measurement_extractor = optionalString(
    s.measurement_extractor,
    'sweep.measurement_extractor',
  );
  if (!measurement_extractor) {
    throw new Error(
      'project-config: sweep.measurement_extractor is required when sweep block is present',
    );
  }
  return { start_command, draw_function, measurement_extractor };
}

function optionalArgv(v: unknown, label: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(`project-config: ${label} must be an argv string[] when present`);
  }
  for (const tok of v) {
    if (typeof tok !== 'string') {
      throw new Error(`project-config: ${label} entries must all be strings`);
    }
  }
  return v as string[];
}

function optionalString(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`project-config: ${label} must be a string when present`);
  }
  return v;
}
