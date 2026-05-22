/**
 * Live status view. Renders a tabular snapshot of queue counts and in-flight
 * initiatives with their current phase + iteration count. Used by `forge status`
 * and by the monitor (tmux pane runs `forge status --watch`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { counts, listInFlight, getPaths } from './queue.ts';
import { loadAliases } from './initiative-id.ts';

export type StatusSnapshot = {
  queueCounts: Record<string, number>;
  inFlight: Array<{
    initiativeId: string;
    handle: string;
    project: string;
    phase: string;
    iteration: number;
    heartbeatAgeSec: number;
    worktreePath?: string;
  }>;
};

export function snapshot(queueRoot = '_queue'): StatusSnapshot {
  const paths = getPaths(queueRoot);
  const aliases = loadAliases({ queueRoot: paths.root });
  return {
    queueCounts: counts(paths),
    inFlight: listInFlight(paths).map((filename) => {
      const row = parseInFlight(filename, paths.inFlight);
      const meta = aliases.by_canonical[row.initiativeId];
      return { ...row, handle: meta?.handle ?? '' };
    }),
  };
}

function parseInFlight(filename: string, inFlightDir: string): Omit<StatusSnapshot['inFlight'][number], 'handle'> {
  const manifestPath = join(inFlightDir, filename);
  const hbPath = join(inFlightDir, filename + '.heartbeat');
  const initiativeId = filename.replace(/\.md$/, '');
  const fm = parseFrontmatter(manifestPath);
  return {
    initiativeId: fm.initiative_id ?? initiativeId,
    project: fm.project ?? '?',
    phase: fm.phase ?? 'unknown',
    iteration: Number(fm.iteration ?? 0),
    heartbeatAgeSec: existsSync(hbPath)
      ? Math.floor((Date.now() - new Date(readFileSync(hbPath, 'utf8').trim()).getTime()) / 1000)
      : -1,
    worktreePath: fm.worktree_path,
  };
}

function parseFrontmatter(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

export function render(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push('Queue:');
  for (const [k, v] of Object.entries(s.queueCounts)) {
    lines.push(`  ${k.padEnd(20)} ${v}`);
  }
  lines.push('');
  lines.push('In-flight initiatives:');
  if (s.inFlight.length === 0) {
    lines.push('  (none)');
  } else {
    // S1.1: handle column sits right of the canonical ID. Empty cell (`-`) when
    // a manifest pre-dates the backfill — operator can re-run backfill-aliases.
    lines.push('  ID                              handle      project       phase                 iter  hb-age');
    for (const f of s.inFlight) {
      lines.push(
        `  ${f.initiativeId.padEnd(31)} ${(f.handle || '-').padEnd(11)} ${f.project.padEnd(13)} ${f.phase.padEnd(21)} ${String(f.iteration).padStart(4)}  ${String(f.heartbeatAgeSec).padStart(5)}s`,
      );
    }
  }
  return lines.join('\n');
}
