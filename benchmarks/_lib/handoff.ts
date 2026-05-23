/**
 * Single canonical bench handoff module (per CONTRACTS.md C10).
 *
 * Reads the artefacts written by the architect bench (and, symmetrically,
 * the PM bench) so downstream phases can consume them without re-running
 * the upstream phase. One module, two exports, one source — there is NO
 * `architect-handoff.ts` or `pm-handoff.ts` file.
 *
 * Layout expected:
 *
 *   benchmarks/architect/results/<iso>/<fixtureId>/
 *     ├── manifest.md
 *     ├── plan-doc.md
 *     └── council-transcript.md
 *
 *   benchmarks/project-manager/results/<iso>/handoff/<fixtureId>/
 *     ├── WI-<n>.md (one or more)
 *     └── _graph.md
 *
 * `<latest>` resolves to the lexicographically-greatest ISO-named result
 * directory present at read time (matches `results/<iso>.json` filename
 * convention: ISO timestamps sort lexicographically). Callers can override
 * via the second arg if they need to pin to a specific run.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readWorkItemsFromDir, type WorkItem } from '../../orchestrator/work-item.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

export type ArchitectHandoff = {
  manifestText: string;
  planDoc: string;
  councilTranscript: string;
};

export type PmHandoff = {
  workItems: WorkItem[];
  graph: string;
  qualityGateCmd: string[];
};

export type HandoffOptions = {
  /** Override the bench results root (absolute path). Defaults to forge repo. */
  forgeRoot?: string;
  /** Pin to a specific run timestamp; otherwise reads the lexicographically latest. */
  runId?: string;
};

export function loadArchitectHandoff(fixtureId: string, opts: HandoffOptions = {}): ArchitectHandoff {
  const root = opts.forgeRoot ?? FORGE_ROOT;
  const resultsRoot = resolve(root, 'benchmarks', 'architect', 'results');
  const runDir = opts.runId
    ? join(resultsRoot, opts.runId)
    : latestRunDir(resultsRoot);
  if (runDir === null) {
    throw new Error(`no architect bench results found under ${resultsRoot}`);
  }
  const fixtureDir = join(runDir, fixtureId);
  if (!existsSync(fixtureDir)) {
    throw new Error(`no architect handoff for fixture '${fixtureId}' under ${runDir}`);
  }
  return {
    manifestText: readRequiredFile(fixtureDir, 'manifest.md'),
    planDoc: readOptionalFile(fixtureDir, 'plan-doc.md'),
    councilTranscript: readOptionalFile(fixtureDir, 'council-transcript.md'),
  };
}

export function loadPmHandoff(fixtureId: string, opts: HandoffOptions = {}): PmHandoff {
  const root = opts.forgeRoot ?? FORGE_ROOT;
  const resultsRoot = resolve(root, 'benchmarks', 'project-manager', 'results');
  const runDir = opts.runId
    ? join(resultsRoot, opts.runId)
    : latestRunDir(resultsRoot);
  if (runDir === null) {
    throw new Error(`no project-manager bench results found under ${resultsRoot}`);
  }
  const fixtureDir = join(runDir, 'handoff', fixtureId);
  if (!existsSync(fixtureDir)) {
    throw new Error(`no PM handoff for fixture '${fixtureId}' under ${runDir}/handoff`);
  }
  const { items } = readWorkItemsFromDir(fixtureDir);
  const graphPath = join(fixtureDir, '_graph.md');
  const graph = existsSync(graphPath) ? readFileSync(graphPath, 'utf8') : '';
  const qualityGateCmdPath = join(fixtureDir, '_quality-gate.json');
  let qualityGateCmd: string[] = [];
  if (existsSync(qualityGateCmdPath)) {
    try {
      const parsed = JSON.parse(readFileSync(qualityGateCmdPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        qualityGateCmd = parsed as string[];
      }
    } catch {
      /* leave empty */
    }
  }
  return { workItems: items, graph, qualityGateCmd };
}

function latestRunDir(resultsRoot: string): string | null {
  if (!existsSync(resultsRoot)) return null;
  const entries = readdirSync(resultsRoot).filter((name) => {
    const full = join(resultsRoot, name);
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  // ISO timestamps sort lexicographically.
  entries.sort();
  return join(resultsRoot, entries[entries.length - 1]!);
}

function readRequiredFile(dir: string, name: string): string {
  const full = join(dir, name);
  if (!existsSync(full)) {
    throw new Error(`missing required handoff file: ${full}`);
  }
  return readFileSync(full, 'utf8');
}

function readOptionalFile(dir: string, name: string): string {
  const full = join(dir, name);
  if (!existsSync(full)) return '';
  return readFileSync(full, 'utf8');
}
