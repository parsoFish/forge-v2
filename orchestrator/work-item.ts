/**
 * Work-item — typed schema + parse/serialise/validate/write/coupling-detect.
 *
 * The project-manager phase emits work items; the orchestrator validates them
 * before dispatching to the developer loop. Sibling of `manifest.ts` — same
 * shape (gray-matter frontmatter + markdown body), same DFS three-color cycle
 * detection.
 *
 * Schema and rules locked in ADR 015. Files live at
 * `<worktree>/.forge/work-items/WI-<n>.md`; the dependency graph at
 * `<worktree>/.forge/work-items/_graph.md`.
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';

export type AcceptanceCriterion = {
  given: string;
  when: string;
  then: string;
};

export type WorkItemStatus = 'pending' | 'in-progress' | 'complete' | 'failed';

export type WorkItem = {
  work_item_id: string;            // WI-<n>
  feature_id: string;              // FEAT-<n>
  initiative_id: string;           // INIT-<YYYY-MM-DD>-<slug>
  status: WorkItemStatus;
  depends_on: string[];            // WI-ids
  acceptance_criteria: AcceptanceCriterion[];
  files_in_scope: string[];        // worktree-relative
  estimated_iterations: number;    // > 0
  /**
   * S3 refinement (2026-05-20, ADR 015 §"Refinement 2026-05-20" + CONTRACTS.md
   * C5). The four fields below are OPTIONAL and serialised **omit-on-undefined**
   * — a WI without any of them produces frontmatter byte-identical to the
   * pre-amendment shape (round-trip test in work-item.test.ts).
   */

  /** Per-WI gate command override (defaults to manifest's). Non-empty when set. */
  quality_gate_cmd?: string[];
  /** Explicit out-of-scope items for this WI (passed through from manifest non_goals). */
  non_goals?: string[];
  /** Path (must appear in files_in_scope) the dev-loop must produce that the gate exercises. */
  verification_artifact?: string;
  /** Structured marker — files this WI creates from scratch. Subset of files_in_scope. */
  creates?: string[];
  body: string;
};

const WORK_ITEM_ID_PATTERN = /^WI-\d+$/;
const FEATURE_ID_PATTERN = /^FEAT-\d+$/;
const INITIATIVE_ID_PATTERN = /^INIT-\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['pending', 'in-progress', 'complete', 'failed'];

export function parseWorkItem(content: string): WorkItem {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;

  const work_item_id = stringField(data, 'work_item_id', true);
  const feature_id = stringField(data, 'feature_id', true);
  const initiative_id = stringField(data, 'initiative_id', true);
  const statusRaw = stringField(data, 'status', false) ?? 'pending';
  const status = (WORK_ITEM_STATUSES.includes(statusRaw as WorkItemStatus)
    ? statusRaw
    : 'pending') as WorkItemStatus;

  const depends_on = parseStringArray(data, 'depends_on');
  const files_in_scope = parseStringArray(data, 'files_in_scope');
  const estimated_iterations = numberField(data, 'estimated_iterations', false) ?? 0;
  const acceptance_criteria = parseAcceptanceCriteria(data);

  const w: WorkItem = {
    work_item_id,
    feature_id,
    initiative_id,
    status,
    depends_on,
    acceptance_criteria,
    files_in_scope,
    estimated_iterations,
    body: parsed.content.replace(/^\n+/, ''),
  };

  // S3 refinement (C5): omit-on-undefined optional fields. Only set the
  // property if the frontmatter declared it.
  if (Array.isArray(data.quality_gate_cmd)) {
    const cmd = (data.quality_gate_cmd as unknown[]).filter((s): s is string => typeof s === 'string');
    if (cmd.length > 0) w.quality_gate_cmd = cmd;
  }
  if (Array.isArray(data.non_goals)) {
    const ng = (data.non_goals as unknown[]).filter((s): s is string => typeof s === 'string');
    if (ng.length > 0) w.non_goals = ng;
  }
  if (typeof data.verification_artifact === 'string' && data.verification_artifact.length > 0) {
    w.verification_artifact = data.verification_artifact;
  }
  if (Array.isArray(data.creates)) {
    const c = (data.creates as unknown[]).filter((s): s is string => typeof s === 'string');
    if (c.length > 0) w.creates = c;
  }

  return w;
}

export function serializeWorkItem(w: WorkItem): string {
  const data: Record<string, unknown> = {
    work_item_id: w.work_item_id,
    feature_id: w.feature_id,
    initiative_id: w.initiative_id,
    status: w.status,
    depends_on: w.depends_on,
    acceptance_criteria: w.acceptance_criteria.map((c) => ({
      given: c.given,
      when: c.when,
      then: c.then,
    })),
    files_in_scope: w.files_in_scope,
    estimated_iterations: w.estimated_iterations,
  };
  // S3 refinement (C5): omit-on-undefined. When a WI doesn't carry the new
  // fields, frontmatter stays byte-identical to the pre-amendment shape
  // (load-bearing round-trip test in work-item.test.ts).
  if (w.quality_gate_cmd !== undefined && w.quality_gate_cmd.length > 0) {
    data.quality_gate_cmd = w.quality_gate_cmd;
  }
  if (w.non_goals !== undefined && w.non_goals.length > 0) {
    data.non_goals = w.non_goals;
  }
  if (w.verification_artifact !== undefined && w.verification_artifact.length > 0) {
    data.verification_artifact = w.verification_artifact;
  }
  if (w.creates !== undefined && w.creates.length > 0) {
    data.creates = w.creates;
  }
  return matter.stringify('\n' + w.body.replace(/^\n+/, ''), data);
}

export type ValidateOptions = {
  /** WI-ids known to exist in the same initiative; depends_on entries must resolve here. */
  knownWorkItemIds?: ReadonlySet<string>;
  /** Initiative ID this WI is expected to belong to; if set, mismatch is an error. */
  expectedInitiativeId?: string;
  /** Feature IDs known to exist in the parent manifest; if set, feature_id mismatch is an error. */
  knownFeatureIds?: ReadonlySet<string>;
};

export function validateWorkItem(w: WorkItem, opts: ValidateOptions = {}): string[] {
  const errors: string[] = [];

  if (!w.work_item_id) {
    errors.push('work_item_id is required');
  } else if (!WORK_ITEM_ID_PATTERN.test(w.work_item_id)) {
    errors.push(`work_item_id must match WI-<n>: got ${w.work_item_id}`);
  }

  if (!w.feature_id) {
    errors.push('feature_id is required');
  } else if (!FEATURE_ID_PATTERN.test(w.feature_id)) {
    errors.push(`feature_id must match FEAT-<n>: got ${w.feature_id}`);
  } else if (opts.knownFeatureIds && !opts.knownFeatureIds.has(w.feature_id)) {
    errors.push(`feature_id ${w.feature_id} is not declared in the initiative manifest`);
  }

  if (!w.initiative_id) {
    errors.push('initiative_id is required');
  } else if (!INITIATIVE_ID_PATTERN.test(w.initiative_id)) {
    errors.push(`initiative_id must match INIT-YYYY-MM-DD-<slug>: got ${w.initiative_id}`);
  } else if (opts.expectedInitiativeId && w.initiative_id !== opts.expectedInitiativeId) {
    errors.push(`initiative_id ${w.initiative_id} does not match expected ${opts.expectedInitiativeId}`);
  }

  if (!WORK_ITEM_STATUSES.includes(w.status)) {
    errors.push(`status must be one of ${WORK_ITEM_STATUSES.join('|')}: got ${w.status}`);
  }

  for (const dep of w.depends_on) {
    if (!WORK_ITEM_ID_PATTERN.test(dep)) {
      errors.push(`depends_on entry malformed: ${dep}`);
    } else if (dep === w.work_item_id) {
      errors.push(`depends_on may not reference self: ${dep}`);
    } else if (opts.knownWorkItemIds && !opts.knownWorkItemIds.has(dep)) {
      errors.push(`depends_on references unknown work item: ${dep}`);
    }
  }

  if (w.acceptance_criteria.length === 0) {
    errors.push('acceptance_criteria must have at least one entry');
  } else {
    for (let i = 0; i < w.acceptance_criteria.length; i++) {
      const c = w.acceptance_criteria[i]!;
      if (!c.given.trim()) errors.push(`acceptance_criteria[${i}].given is empty`);
      if (!c.when.trim()) errors.push(`acceptance_criteria[${i}].when is empty`);
      if (!c.then.trim()) errors.push(`acceptance_criteria[${i}].then is empty`);
    }
  }

  if (w.files_in_scope.length === 0) {
    errors.push('files_in_scope must have at least one entry');
  } else {
    for (const f of w.files_in_scope) {
      if (!f.trim()) {
        errors.push('files_in_scope entry is empty');
      } else if (f.startsWith('/')) {
        errors.push(`files_in_scope entry must be worktree-relative (no leading /): ${f}`);
      } else if (f.split('/').includes('..')) {
        errors.push(`files_in_scope entry may not contain '..': ${f}`);
      }
    }
  }

  if (!(w.estimated_iterations > 0)) {
    errors.push(`estimated_iterations must be > 0: got ${w.estimated_iterations}`);
  }

  // S3 refinement (C5): validate the new optional fields. All four are
  // optional — but if present, they must be well-formed.
  if (w.quality_gate_cmd !== undefined) {
    if (!Array.isArray(w.quality_gate_cmd) || w.quality_gate_cmd.length === 0) {
      errors.push('quality_gate_cmd must be a non-empty array of strings when set');
    } else if (!w.quality_gate_cmd.every((s) => typeof s === 'string' && s.length > 0)) {
      errors.push('quality_gate_cmd entries must be non-empty strings');
    }
  }
  if (w.non_goals !== undefined) {
    if (!Array.isArray(w.non_goals)) {
      errors.push('non_goals must be an array of strings when set');
    } else if (!w.non_goals.every((s) => typeof s === 'string' && s.length > 0)) {
      errors.push('non_goals entries must be non-empty strings');
    }
  }
  if (w.verification_artifact !== undefined) {
    if (typeof w.verification_artifact !== 'string' || w.verification_artifact.length === 0) {
      errors.push('verification_artifact must be a non-empty string when set');
    } else if (!w.files_in_scope.includes(w.verification_artifact)) {
      errors.push(
        `verification_artifact ${w.verification_artifact} must appear in files_in_scope`,
      );
    }
  }
  if (w.creates !== undefined) {
    if (!Array.isArray(w.creates)) {
      errors.push('creates must be an array of strings when set');
    } else {
      for (const path of w.creates) {
        if (typeof path !== 'string' || path.length === 0) {
          errors.push('creates entries must be non-empty strings');
        } else if (!w.files_in_scope.includes(path)) {
          errors.push(`creates entry ${path} must appear in files_in_scope`);
        }
      }
    }
  }

  return errors;
}

/**
 * Validate the whole set together — checks individual WIs plus cross-WI rules
 * (no duplicate IDs, no dependency cycles).
 */
export function validateWorkItemSet(items: WorkItem[], opts: Omit<ValidateOptions, 'knownWorkItemIds'> = {}): {
  perItem: Record<string, string[]>;
  setErrors: string[];
} {
  const perItem: Record<string, string[]> = {};
  const knownIds = new Set(items.map((i) => i.work_item_id).filter((id) => WORK_ITEM_ID_PATTERN.test(id)));
  for (const item of items) {
    perItem[item.work_item_id] = validateWorkItem(item, { ...opts, knownWorkItemIds: knownIds });
  }

  const setErrors: string[] = [];

  const seen = new Set<string>();
  for (const item of items) {
    if (!item.work_item_id) continue;
    if (seen.has(item.work_item_id)) {
      setErrors.push(`duplicate work_item_id: ${item.work_item_id}`);
    }
    seen.add(item.work_item_id);
  }

  const cycle = detectCycle(items);
  if (cycle) setErrors.push(`work-item dependency cycle: ${cycle.join(' → ')}`);

  return { perItem, setErrors };
}

export function readWorkItemsFromDir(dir: string): {
  items: WorkItem[];
  parseErrors: Record<string, string>;
} {
  if (!existsSync(dir)) return { items: [], parseErrors: {} };

  const items: WorkItem[] = [];
  const parseErrors: Record<string, string> = {};
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== '_graph.md')
    .sort();

  for (const file of files) {
    const full = join(dir, file);
    try {
      items.push(parseWorkItem(readFileSync(full, 'utf8')));
    } catch (err) {
      parseErrors[file] = err instanceof Error ? err.message : String(err);
    }
  }
  return { items, parseErrors };
}

export type WriteWorkItemOptions = {
  /** `<worktree>/.forge/work-items/`. Created if missing. */
  workItemsDir?: string;
};

export function writeWorkItem(w: WorkItem, worktreeDir: string, opts: WriteWorkItemOptions = {}): string {
  const errors = validateWorkItem(w);
  if (errors.length > 0) {
    throw new Error(`invalid work item:\n  - ${errors.join('\n  - ')}`);
  }
  const dir = opts.workItemsDir ?? resolve(worktreeDir, '.forge', 'work-items');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, `${w.work_item_id}.md`);
  writeFileSync(out, serializeWorkItem(w));
  return out;
}

/**
 * Update the `status` field in an existing work-item file's YAML frontmatter,
 * leaving every other field and the markdown body byte-identical (round-trip
 * via gray-matter). Used by the developer-loop runner to mark each WI
 * complete | failed after the Ralph loop returns.
 */
export function writeWorkItemStatus(specPath: string, status: WorkItemStatus): void {
  if (!WORK_ITEM_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const w = parseWorkItem(readFileSync(specPath, 'utf8'));
  const updated: WorkItem = { ...w, status };
  writeFileSync(specPath, serializeWorkItem(updated));
}

/**
 * Find pairs of work items that share a file in `files_in_scope` but are not
 * connected by any directed dependency edge in either direction (transitively).
 *
 * Hidden coupling = merge-time conflict risk. PM's last-step self-check from
 * docs/phases/project-manager.md:59. Drives the `no_hidden_file_coupling`
 * benchmark criterion.
 *
 * Reachability is checked in both directions because a `depends_on` edge
 * serialises the two items (the dependent runs after the prerequisite), which
 * is enough to avoid concurrent edits to the shared file. We only flag pairs
 * that are mutually unreachable.
 */
export type CouplingPair = { a: string; b: string; sharedFiles: string[] };

export function detectHiddenCoupling(items: WorkItem[]): CouplingPair[] {
  const fileToItems = new Map<string, string[]>();
  for (const item of items) {
    for (const file of item.files_in_scope) {
      const list = fileToItems.get(file) ?? [];
      list.push(item.work_item_id);
      fileToItems.set(file, list);
    }
  }

  const adj = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();
  for (const item of items) {
    adj.set(item.work_item_id, item.depends_on.slice());
    for (const dep of item.depends_on) {
      const list = reverseAdj.get(dep) ?? [];
      list.push(item.work_item_id);
      reverseAdj.set(dep, list);
    }
  }
  for (const item of items) {
    if (!reverseAdj.has(item.work_item_id)) reverseAdj.set(item.work_item_id, []);
  }

  function reachable(from: string, to: string, graph: Map<string, string[]>): boolean {
    if (from === to) return true;
    const stack = [from];
    const seen = new Set<string>([from]);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of graph.get(cur) ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  const pairs = new Map<string, CouplingPair>();
  for (const [file, ids] of fileToItems.entries()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        const connected =
          reachable(a, b, adj) ||
          reachable(b, a, adj) ||
          reachable(a, b, reverseAdj) ||
          reachable(b, a, reverseAdj);
        if (connected) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const existing = pairs.get(key);
        if (existing) {
          if (!existing.sharedFiles.includes(file)) existing.sharedFiles.push(file);
        } else {
          pairs.set(key, { a: a < b ? a : b, b: a < b ? b : a, sharedFiles: [file] });
        }
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Return work items in dependency order: every WI's prerequisites appear
 * before it. Items with `depends_on` references that don't resolve in `items`
 * are treated as roots (orphan dependency = upstream-validation responsibility).
 * Throws if a cycle is present — callers should run `validateWorkItemSet`
 * first if they want a structured error.
 */
export function topologicalOrder(items: WorkItem[]): WorkItem[] {
  const cycle = detectCycle(items);
  if (cycle) {
    throw new Error(`cannot topo-sort: dependency cycle ${cycle.join(' → ')}`);
  }
  const byId = new Map(items.map((i) => [i.work_item_id, i] as const));
  const indegree = new Map<string, number>();
  for (const item of items) indegree.set(item.work_item_id, 0);
  for (const item of items) {
    for (const dep of item.depends_on) {
      if (byId.has(dep)) {
        indegree.set(item.work_item_id, (indegree.get(item.work_item_id) ?? 0) + 1);
      }
    }
  }
  const ready = items
    .filter((i) => (indegree.get(i.work_item_id) ?? 0) === 0)
    .map((i) => i.work_item_id)
    .sort();
  const out: WorkItem[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const item = byId.get(id);
    if (!item) continue;
    out.push(item);
    for (const other of items) {
      if (other.depends_on.includes(id)) {
        const next = (indegree.get(other.work_item_id) ?? 0) - 1;
        indegree.set(other.work_item_id, next);
        if (next === 0) {
          insertSorted(ready, other.work_item_id);
        }
      }
    }
  }
  return out;
}

function insertSorted(list: string[], value: string): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, value);
}

// ---------- helpers ----------

function stringField(data: Record<string, unknown>, key: string, required: boolean): string {
  const v = data[key];
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (required) throw new Error(`work item missing required field: ${key}`);
  return '';
}

function numberField(data: Record<string, unknown>, key: string, required: boolean): number | null {
  const v = data[key];
  if (typeof v === 'number') return v;
  if (required) throw new Error(`work item missing required numeric field: ${key}`);
  return null;
}

function parseStringArray(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x): x is string => typeof x === 'string');
}

function parseAcceptanceCriteria(data: Record<string, unknown>): AcceptanceCriterion[] {
  const v = data['acceptance_criteria'];
  if (!Array.isArray(v)) return [];
  const out: AcceptanceCriterion[] = [];
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    out.push({
      given: typeof obj.given === 'string' ? obj.given : '',
      when: typeof obj.when === 'string' ? obj.when : '',
      then: typeof obj.then === 'string' ? obj.then : '',
    });
  }
  return out;
}

/** DFS three-color cycle detection across work items. */
function detectCycle(items: WorkItem[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const item of items) adj.set(item.work_item_id, item.depends_on);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);

  const stack: string[] = [];
  function visit(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep);
      if (c === undefined) continue;
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
