/**
 * Initiative manifest — typed schema + parse/serialise/validate/write.
 *
 * The architect emits manifests; the orchestrator reads them when claiming.
 * Manifests live as markdown files with YAML frontmatter under
 * `_queue/{pending,in-flight,...}/<initiative-id>.md`.
 *
 * Per ADR 007 (markdown artifacts) and ADR 011 (file-based queue).
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';

export type Feature = {
  feature_id: string;          // FEAT-<n>
  title: string;
  depends_on: string[];        // feature_ids of prerequisite features
};

export type ManifestPhase = 'pending' | 'in-flight' | 'ready-for-review' | 'done' | 'failed';

export type InitiativeManifest = {
  initiative_id: string;       // INIT-<YYYY-MM-DD>-<slug>
  project: string;
  project_repo_path: string;
  created_at: string;          // ISO-8601
  iteration_budget: number;    // > 0
  cost_budget_usd: number;     // > 0
  phase: ManifestPhase;
  features: Feature[];
  /**
   * F-25: initiative-level dependencies. Each entry is another initiative_id
   * that must be in `_queue/done/` before the scheduler may claim this one.
   * Empty / absent = no prerequisites. Distinct from `features[].depends_on`,
   * which orders work-items WITHIN this initiative.
   */
  depends_on_initiatives?: string[];
  /**
   * F-27: number of times this manifest has been auto-retried by the
   * scheduler after a recoverable failure. Used as a cap (`MAX_AUTO_RETRIES`)
   * to prevent infinite retry loops. Annotated by the scheduler on each
   * recovery; humans can also reset it manually if they amend the manifest
   * and want to give it another shot.
   */
  retry_count?: number;
  /**
   * F-27: list of failure modes that have previously caused this manifest
   * to be auto-retried. If the same mode shows up retry_count + 1 times,
   * that's strong evidence the issue isn't transient — the next failure
   * stops in `failed/` regardless of the mode's nominal `recoverable: true`.
   */
  previous_failure_modes?: string[];
  body: string;                // markdown initiative spec
  /**
   * Optional per-project quality-gate command. Used by both the dev-loop
   * (Ralph stop condition) and the reviewer (orchestrator-side gate). When
   * absent, falls back to `npm test` if `package.json` exists in the
   * worktree, else `true` (no-op gate). Single source of truth — both phases
   * use the same command, eliminating drift (F-04 / F-06).
   *
   * Examples:
   *   ['npm', 'test']
   *   ['pytest', '-q']
   *   ['cargo', 'test', '--all']
   *   ['bats', 'tests/']
   */
  quality_gate_cmd?: string[];
  // Optional runtime fields written by the scheduler
  claimed_at?: string;
  claimed_by?: string;
  worktree_path?: string;
};

const INITIATIVE_ID_PATTERN = /^INIT-\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const FEATURE_ID_PATTERN = /^FEAT-\d+$/;

export function parseManifest(content: string): InitiativeManifest {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;

  const initiative_id = stringField(data, 'initiative_id', true);
  const project = stringField(data, 'project', true);
  const created_at = stringField(data, 'created_at', true);
  const project_repo_path = stringField(data, 'project_repo_path', false) ?? '';
  const iteration_budget = numberField(data, 'iteration_budget', true);
  const cost_budget_usd = numberField(data, 'cost_budget_usd', true);
  const phase = (stringField(data, 'phase', false) ?? 'pending') as ManifestPhase;

  const rawFeatures = Array.isArray(data.features) ? (data.features as unknown[]) : [];
  const features: Feature[] = rawFeatures.map((f, i) => parseFeature(f, i));

  const manifest: InitiativeManifest = {
    initiative_id,
    project,
    project_repo_path,
    created_at,
    iteration_budget,
    cost_budget_usd,
    phase,
    features,
    body: parsed.content.replace(/^\n+/, ''),
  };
  if (typeof data.claimed_at === 'string') manifest.claimed_at = data.claimed_at;
  if (typeof data.claimed_by === 'string') manifest.claimed_by = data.claimed_by;
  if (typeof data.worktree_path === 'string') manifest.worktree_path = data.worktree_path;
  if (Array.isArray(data.quality_gate_cmd)) {
    const cmd = (data.quality_gate_cmd as unknown[]).filter((s): s is string => typeof s === 'string');
    if (cmd.length > 0) manifest.quality_gate_cmd = cmd;
  }
  if (Array.isArray(data.depends_on_initiatives)) {
    const deps = (data.depends_on_initiatives as unknown[]).filter((s): s is string => typeof s === 'string');
    if (deps.length > 0) manifest.depends_on_initiatives = deps;
  }
  if (typeof data.retry_count === 'number') manifest.retry_count = data.retry_count;
  if (Array.isArray(data.previous_failure_modes)) {
    const modes = (data.previous_failure_modes as unknown[]).filter((s): s is string => typeof s === 'string');
    if (modes.length > 0) manifest.previous_failure_modes = modes;
  }
  return manifest;
}

export function serializeManifest(m: InitiativeManifest): string {
  const data: Record<string, unknown> = {
    initiative_id: m.initiative_id,
    project: m.project,
    project_repo_path: m.project_repo_path,
    created_at: m.created_at,
    iteration_budget: m.iteration_budget,
    cost_budget_usd: m.cost_budget_usd,
    phase: m.phase,
  };
  if (m.claimed_at) data.claimed_at = m.claimed_at;
  if (m.claimed_by) data.claimed_by = m.claimed_by;
  if (m.worktree_path) data.worktree_path = m.worktree_path;
  if (m.quality_gate_cmd && m.quality_gate_cmd.length > 0) {
    data.quality_gate_cmd = m.quality_gate_cmd;
  }
  if (m.depends_on_initiatives && m.depends_on_initiatives.length > 0) {
    data.depends_on_initiatives = m.depends_on_initiatives;
  }
  if (typeof m.retry_count === 'number' && m.retry_count > 0) {
    data.retry_count = m.retry_count;
  }
  if (m.previous_failure_modes && m.previous_failure_modes.length > 0) {
    data.previous_failure_modes = m.previous_failure_modes;
  }
  if (m.features.length > 0) {
    data.features = m.features.map((f) => ({
      feature_id: f.feature_id,
      title: f.title,
      depends_on: f.depends_on,
    }));
  }
  return matter.stringify('\n' + m.body.replace(/^\n+/, ''), data);
}

export function validateManifest(m: InitiativeManifest): string[] {
  const errors: string[] = [];

  if (!m.initiative_id) {
    errors.push('initiative_id is required');
  } else if (!INITIATIVE_ID_PATTERN.test(m.initiative_id)) {
    errors.push(`initiative_id must match pattern INIT-YYYY-MM-DD-<slug>: got ${m.initiative_id}`);
  }
  if (!m.project) errors.push('project is required');
  if (!m.created_at) errors.push('created_at is required');
  if (!(m.iteration_budget > 0)) errors.push(`iteration_budget must be > 0: got ${m.iteration_budget}`);
  if (!(m.cost_budget_usd > 0)) errors.push(`cost_budget_usd must be > 0: got ${m.cost_budget_usd}`);
  if (m.quality_gate_cmd !== undefined) {
    if (!Array.isArray(m.quality_gate_cmd) || m.quality_gate_cmd.length === 0) {
      errors.push('quality_gate_cmd must be a non-empty array of strings when set');
    } else if (!m.quality_gate_cmd.every((s) => typeof s === 'string' && s.length > 0)) {
      errors.push('quality_gate_cmd entries must be non-empty strings');
    }
  }
  if (m.depends_on_initiatives !== undefined) {
    if (!Array.isArray(m.depends_on_initiatives)) {
      errors.push('depends_on_initiatives must be an array of initiative_id strings when set');
    } else {
      for (const dep of m.depends_on_initiatives) {
        if (typeof dep !== 'string' || !INITIATIVE_ID_PATTERN.test(dep)) {
          errors.push(`depends_on_initiatives entry must match INIT-YYYY-MM-DD-<slug>: got ${dep}`);
        }
        if (dep === m.initiative_id) {
          errors.push(`depends_on_initiatives cannot contain self (${dep})`);
        }
      }
    }
  }

  // Feature shape + dependency graph
  const ids = new Set<string>();
  for (const f of m.features) {
    if (!f.feature_id || !FEATURE_ID_PATTERN.test(f.feature_id)) {
      errors.push(`feature ${f.feature_id || '<missing>'} must match FEAT-<n>`);
      continue;
    }
    if (ids.has(f.feature_id)) errors.push(`duplicate feature_id: ${f.feature_id}`);
    ids.add(f.feature_id);
  }
  for (const f of m.features) {
    for (const dep of f.depends_on) {
      if (!ids.has(dep)) errors.push(`feature ${f.feature_id}: depends_on references undeclared ${dep}`);
    }
  }
  const cycle = detectCycle(m.features);
  if (cycle) errors.push(`feature dependency cycle: ${cycle.join(' → ')}`);

  return errors;
}

export type WriteOptions = {
  queueRoot?: string;          // defaults to './_queue'
};

export function writeManifest(m: InitiativeManifest, opts: WriteOptions = {}): string {
  const errors = validateManifest(m);
  if (errors.length > 0) {
    throw new Error(`invalid manifest:\n  - ${errors.join('\n  - ')}`);
  }
  const queueRoot = resolve(opts.queueRoot ?? '_queue');
  const pending = join(queueRoot, 'pending');
  if (!existsSync(pending)) mkdirSync(pending, { recursive: true });
  const out = join(pending, `${m.initiative_id}.md`);
  writeFileSync(out, serializeManifest(m));
  return out;
}

// ---------- helpers ----------

function stringField(data: Record<string, unknown>, key: string, required: boolean): string {
  const v = data[key];
  if (typeof v === 'string') return v;
  // YAML parses ISO-8601 timestamps as Date — coerce back to ISO string.
  if (v instanceof Date) return v.toISOString();
  if (required) throw new Error(`manifest missing required field: ${key}`);
  return '';
}

function numberField(data: Record<string, unknown>, key: string, required: boolean): number {
  const v = data[key];
  if (typeof v === 'number') return v;
  if (required) throw new Error(`manifest missing required numeric field: ${key}`);
  return 0;
}

function parseFeature(f: unknown, idx: number): Feature {
  if (typeof f !== 'object' || f === null) {
    throw new Error(`features[${idx}] must be an object`);
  }
  const obj = f as Record<string, unknown>;
  const feature_id = typeof obj.feature_id === 'string' ? obj.feature_id : '';
  const title = typeof obj.title === 'string' ? obj.title : '';
  const depends_on = Array.isArray(obj.depends_on)
    ? (obj.depends_on as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { feature_id, title, depends_on };
}

/** DFS cycle detection across features. Returns the cycle path if one is found. */
function detectCycle(features: Feature[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const f of features) adj.set(f.feature_id, f.depends_on);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);

  const stack: string[] = [];
  function visit(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep);
      if (c === undefined) continue;            // undeclared — flagged elsewhere
      if (c === GRAY) return [...stack.slice(stack.indexOf(dep)), dep];
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}
