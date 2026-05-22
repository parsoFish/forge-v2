#!/usr/bin/env node
/**
 * One-shot backfill: walk `_queue/{pending,in-flight,ready-for-review,done,failed}/*.md`
 * in `created_at` order, mint a handle for each via `mintHandle`, and persist
 * `_queue/_aliases.json`. Idempotent — if a canonical is already in the
 * registry, it is skipped (the handle is left untouched).
 *
 * Why created_at order: it matches the order operators created initiatives,
 * so the resulting handle sequence is grep-friendly (`traf#1` is the first
 * trafficGame ever, `traf#2` is the second, etc.).
 *
 * Usage:  node --experimental-strip-types scripts/backfill-aliases.ts [queueRoot]
 * Default queueRoot = `<forge-root>/_queue` (resolved from this script's dir).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { loadAliases, mintHandle, registryPath } from '../orchestrator/initiative-id.ts';

// Resolve the forge root from the script location so we work whether the
// user runs us from inside _worktrees/ or from the repo root.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = resolve(SCRIPT_DIR, '..');

const QUEUE_DIRS = ['pending', 'in-flight', 'ready-for-review', 'done', 'failed'] as const;

type Candidate = {
  canonical: string;
  filename: string;
  state: (typeof QUEUE_DIRS)[number];
  createdAt: Date;
};

function readCreatedAt(manifestPath: string): Date {
  try {
    const content = readFileSync(manifestPath, 'utf8');
    const fm = matter(content);
    const raw = (fm.data as Record<string, unknown>).created_at;
    if (typeof raw === 'string') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    /* fall through */
  }
  // Fallback: file mtime. Better than crashing on a malformed manifest.
  try {
    return statSync(manifestPath).mtime;
  } catch {
    return new Date(0);
  }
}

function collectCandidates(queueRoot: string): Candidate[] {
  const out: Candidate[] = [];
  for (const state of QUEUE_DIRS) {
    const dir = join(queueRoot, state);
    if (!existsSync(dir)) continue;
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith('.md')) continue;
      const canonical = filename.replace(/\.md$/, '');
      const createdAt = readCreatedAt(join(dir, filename));
      out.push({ canonical, filename, state, createdAt });
    }
  }
  // Stable sort: earliest first; ties broken by canonical id (deterministic
  // across runs even when two manifests share a created_at).
  out.sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.canonical.localeCompare(b.canonical);
  });
  return out;
}

async function main(argv: string[]): Promise<number> {
  const queueRoot = argv[0] ?? join(FORGE_ROOT, '_queue');
  if (!existsSync(queueRoot)) {
    process.stderr.write(`backfill-aliases: queue root not found at ${queueRoot}\n`);
    return 1;
  }

  // Destructive-instruction guard: if a registry already exists, back it up
  // before touching anything. The mint logic is idempotent so this is
  // belt-and-braces, but the operator can sleep easier seeing the .backup.
  const regPath = registryPath(queueRoot);
  if (existsSync(regPath)) {
    const backup = `${regPath}.s1.1-backup`;
    if (!existsSync(backup)) {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(regPath, backup);
      process.stdout.write(`backed up existing registry → ${backup}\n`);
    }
  }

  const candidates = collectCandidates(queueRoot);
  process.stdout.write(`backfill-aliases: ${candidates.length} manifest(s) to consider\n`);

  let minted = 0;
  let skipped = 0;
  for (const c of candidates) {
    const reg = loadAliases({ queueRoot });
    if (reg.by_canonical[c.canonical]) {
      skipped++;
      continue;
    }
    try {
      const r = await mintHandle(c.canonical, { queueRoot });
      process.stdout.write(`  minted ${r.handle.padEnd(10)} ${c.canonical}  (${c.state})\n`);
      minted++;
    } catch (err) {
      process.stderr.write(
        `  skipped ${c.canonical}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  process.stdout.write(
    `backfill-aliases: done. minted=${minted} skipped=${skipped} registry=${regPath}\n`,
  );
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
