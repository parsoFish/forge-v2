/**
 * Dual-ID resolver for initiative IDs (S1.1 — plan 07b).
 *
 * Canonical IDs (`INIT-YYYY-MM-DD-<project>-<slug>`) are unchanged and
 * remain authoritative everywhere on disk (queue filenames, branches,
 * worktrees, log dirs, manifest YAML). This module adds a parallel
 * **handle** index (`<proj4>#<seq>`, e.g. `traf#7`) — a typing-friendly
 * lookup layer the operator uses in slash commands and CLI calls.
 *
 * Contracts honoured:
 *  - C6  — handle format `<proj4>#<seq>` (suffix-digit walk on prefix
 *          collision; per-project monotonic counter is collision-free
 *          by construction).
 *  - C17 — mint-time writes wrap read+mutate+write in `proper-lockfile`.
 *          Reads (`loadAliases`) are unlocked.
 *  - C16b spirit — corrupt registry treated as empty, the backfill or
 *          next mint regenerates it idempotently.
 *
 * Single source of truth for resolution: `resolveInitiativeId(input)`.
 * Every CLI command that takes `<initiative-id>` routes through it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AliasRegistry = {
  version: 1;
  /** handle (e.g. `traf#7`) → canonical id */
  by_handle: Record<string, string>;
  /** canonical id → { handle, name? } */
  by_canonical: Record<string, { handle: string; name?: string | null }>;
  /** name alias → canonical id */
  by_name: Record<string, string>;
  /** project name (lowercased, slugified) → minted 4-char prefix */
  by_project: Record<string, string>;
  /** prefix → highest sequence number minted under that prefix */
  counters: Record<string, number>;
};

export type ResolveResult =
  | { kind: 'ok'; canonical: string; handle: string; name?: string | null }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'not-found' };

export type MintResult = { handle: string; counter: number; canonical: string };

export type RegistryOpts = {
  /** Path to the `_queue/` directory housing `_aliases.json`. Defaults to
   *  `<forge-root>/_queue` resolved from the CWD (the CLI chdir's to forge
   *  root so this is correct in production). */
  queueRoot?: string;
};

// ---------------------------------------------------------------------------
// Constants / regexes
// ---------------------------------------------------------------------------

/** Mirrors `manifest.ts:103` — kept here as a private helper, NOT re-exported
 *  to avoid drift. Canonical regex is authoritative there. */
const CANONICAL_PATTERN = /^INIT-\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
/** Handle format `<proj4>#<seq>` per C6. */
const HANDLE_PATTERN = /^[a-z0-9]{3,5}#\d+$/;

const REGISTRY_FILE = '_aliases.json';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function registryPath(queueRoot?: string): string {
  const root = queueRoot ?? resolve('_queue');
  return join(root, REGISTRY_FILE);
}

// ---------------------------------------------------------------------------
// Loading + persistence
// ---------------------------------------------------------------------------

function emptyRegistry(): AliasRegistry {
  return {
    version: 1,
    by_handle: {},
    by_canonical: {},
    by_name: {},
    by_project: {},
    counters: {},
  };
}

/**
 * Read the registry from disk. Unlocked per C17 (writers serialise; readers
 * see whatever atomic snapshot is on disk). Missing or corrupt files are
 * treated as an empty registry (C16b spirit — idempotent replay over silent
 * skip; the next mint regenerates everything from canonical IDs).
 */
export function loadAliases(opts: RegistryOpts = {}): AliasRegistry {
  const path = registryPath(opts.queueRoot);
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AliasRegistry>;
    // Light shape coercion so a partial/legacy file still works.
    return {
      version: 1,
      by_handle: parsed.by_handle ?? {},
      by_canonical: parsed.by_canonical ?? {},
      by_name: parsed.by_name ?? {},
      by_project: parsed.by_project ?? {},
      counters: parsed.counters ?? {},
    };
  } catch (err) {
    // Corrupt JSON — treat as empty so the next mint re-derives everything.
    // We log to stderr so the operator notices (per C16b spirit).
    process.stderr.write(
      `[initiative-id] warning: ${path} unparseable (${err instanceof Error ? err.message : String(err)}); treating as empty registry\n`,
    );
    return emptyRegistry();
  }
}

/** Write the registry atomically. Caller MUST hold the lock. */
function persistRegistry(reg: AliasRegistry, opts: RegistryOpts): void {
  const path = registryPath(opts.queueRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(reg, null, 2));
  // POSIX `rename` is atomic. proper-lockfile's lock guarantees no other
  // writer is racing us; the rename just gives readers a consistent file.
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Project-prefix derivation (§1 + §2 of S1.1-DECISIONS.md)
// ---------------------------------------------------------------------------

function slugifyProject(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pull the project name out of a canonical id by parsing the date prefix
 *  off the front. Returns `''` if the id doesn't match the canonical shape
 *  (callers should validate first). */
function projectFromCanonical(canonical: string): string {
  const m = canonical.match(/^INIT-\d{4}-\d{2}-\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (!m) return '';
  // The project is the FIRST slug segment after the date. Subsequent
  // segments are the human slug.
  return m[1].split('-')[0];
}

/** Compute the raw 4-char prefix (right-pad with `0` if shorter). */
function rawPrefix(project: string): string {
  const slug = slugifyProject(project);
  if (slug.length >= 4) return slug.slice(0, 4);
  return (slug + '0000').slice(0, 4);
}

/**
 * Find a prefix for `project`, taking the collision-walk into account.
 *
 * If the project already has a prefix in `by_project`, use it (stable per
 * project for the life of the registry).
 *
 * Otherwise: compute the raw prefix. If it's not in `counters` yet, use it.
 * If it IS in `counters` and bound to a different project, walk suffix
 * digits (`raw[0..3]2`, `raw[0..3]3`, …) until one is free.
 */
function pickPrefix(
  reg: AliasRegistry,
  project: string,
): { prefix: string; collided: boolean } {
  const slug = slugifyProject(project);
  if (reg.by_project[slug]) {
    return { prefix: reg.by_project[slug], collided: false };
  }
  const raw = rawPrefix(slug);
  // Free? Take it.
  if (!(raw in reg.counters)) return { prefix: raw, collided: false };
  // Collision — suffix walk. Replace the last char with an incrementing digit.
  for (let n = 2; n <= 99; n++) {
    const candidate = raw.slice(0, 3) + String(n);
    if (!(candidate in reg.counters)) {
      return { prefix: candidate, collided: true };
    }
  }
  throw new Error(
    `initiative-id: ran out of prefix variants for project "${project}" (raw=${raw}). Rename the project to something less collision-prone.`,
  );
}

// ---------------------------------------------------------------------------
// mintHandle — the only writer of `_aliases.json` for handle entries
// ---------------------------------------------------------------------------

/**
 * Atomically mint (or look up) the handle for a canonical id. Concurrent
 * callers serialise via `proper-lockfile` (C17). Idempotent — re-minting an
 * already-known canonical returns its existing handle without bumping the
 * counter.
 *
 * Emits a stderr warning the first time a project collides with an existing
 * prefix (per plan 07b Q3 — "warn-then-mint").
 */
export async function mintHandle(
  canonical: string,
  opts: RegistryOpts = {},
): Promise<MintResult> {
  if (!CANONICAL_PATTERN.test(canonical)) {
    throw new Error(`initiative-id: not a canonical id: ${canonical}`);
  }
  const path = registryPath(opts.queueRoot);
  // proper-lockfile needs the resource file to exist before it can lock it.
  // Ensure the parent dir and file exist (empty registry) before acquiring.
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(emptyRegistry(), null, 2));
  }

  const release = await lockfile.lock(path, {
    retries: { retries: 50, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
    stale: 30_000,
  });
  try {
    const reg = loadAliases(opts);

    // Idempotent: already minted?
    const existing = reg.by_canonical[canonical];
    if (existing) {
      const m = existing.handle.match(/^(.+)#(\d+)$/);
      return {
        canonical,
        handle: existing.handle,
        counter: m ? Number(m[2]) : 0,
      };
    }

    const project = projectFromCanonical(canonical);
    const projectSlug = slugifyProject(project);
    const { prefix, collided } = pickPrefix(reg, project);
    if (collided) {
      process.stderr.write(
        `[initiative-id] warning: prefix "${rawPrefix(project)}" already claimed; project "${project}" gets "${prefix}" instead.\n`,
      );
    }

    const nextCounter = (reg.counters[prefix] ?? 0) + 1;
    const handle = `${prefix}#${nextCounter}`;

    const next: AliasRegistry = {
      ...reg,
      by_handle: { ...reg.by_handle, [handle]: canonical },
      by_canonical: {
        ...reg.by_canonical,
        [canonical]: { handle, name: null },
      },
      by_project: { ...reg.by_project, [projectSlug]: prefix },
      counters: { ...reg.counters, [prefix]: nextCounter },
    };
    persistRegistry(next, opts);

    return { canonical, handle, counter: nextCounter };
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// mintName — bind a human alias to a handle (operator-driven; plan 07b Q2)
// ---------------------------------------------------------------------------

/**
 * Bind a globally-unique human-readable name to an existing handle.
 * Rejects on:
 *   - unknown handle
 *   - name already bound to a different canonical
 *
 * Idempotent if the name is already bound to the same canonical.
 */
export async function mintName(
  handle: string,
  name: string,
  opts: RegistryOpts = {},
): Promise<void> {
  const path = registryPath(opts.queueRoot);
  if (!existsSync(path)) {
    throw new Error(`initiative-id: registry missing at ${path}`);
  }
  const release = await lockfile.lock(path, {
    retries: { retries: 50, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
    stale: 30_000,
  });
  try {
    const reg = loadAliases(opts);
    const canonical = reg.by_handle[handle];
    if (!canonical) {
      throw new Error(`initiative-id: unknown handle "${handle}"`);
    }
    const existing = reg.by_name[name];
    if (existing && existing !== canonical) {
      throw new Error(
        `initiative-id: name "${name}" already taken (points at ${existing}); pick another`,
      );
    }
    const next: AliasRegistry = {
      ...reg,
      by_name: { ...reg.by_name, [name]: canonical },
      by_canonical: {
        ...reg.by_canonical,
        [canonical]: { handle, name },
      },
    };
    persistRegistry(next, opts);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// resolveInitiativeId — the only reader the CLI should use
// ---------------------------------------------------------------------------

/**
 * Map any operator-typed input to a canonical id.
 *
 * Accepts (in order of precedence):
 *  1. Canonical id (returned as-is; handle filled in from registry if known)
 *  2. Handle `proj#N` (via `by_handle`)
 *  3. Named alias (via `by_name`)
 *  4. Globally-unique canonical substring (e.g. `slugify-batch` resolves
 *     when exactly one canonical contains that token between the date and
 *     end). Multiple matches ⇒ `kind: 'ambiguous'`.
 *
 * The CLI wraps `kind: 'ambiguous'` into a stderr message + exit(2).
 */
export function resolveInitiativeId(
  input: string,
  opts: RegistryOpts = {},
): ResolveResult {
  const trimmed = input.trim();
  if (trimmed === '') return { kind: 'not-found' };

  const reg = loadAliases(opts);

  // 1. Canonical exact match.
  if (CANONICAL_PATTERN.test(trimmed)) {
    const meta = reg.by_canonical[trimmed];
    return {
      kind: 'ok',
      canonical: trimmed,
      handle: meta?.handle ?? '',
      name: meta?.name ?? null,
    };
  }

  // 2. Handle exact match.
  if (HANDLE_PATTERN.test(trimmed) && reg.by_handle[trimmed]) {
    const canonical = reg.by_handle[trimmed];
    const meta = reg.by_canonical[canonical];
    return {
      kind: 'ok',
      canonical,
      handle: trimmed,
      name: meta?.name ?? null,
    };
  }

  // 3. Named alias.
  if (reg.by_name[trimmed]) {
    const canonical = reg.by_name[trimmed];
    const meta = reg.by_canonical[canonical];
    return {
      kind: 'ok',
      canonical,
      handle: meta?.handle ?? '',
      name: trimmed,
    };
  }

  // 4. Substring search over known canonicals (case-insensitive). This is
  //    the "talk about it by a piece of the slug" fallback the plan mentions.
  const needle = trimmed.toLowerCase();
  const matches = Object.keys(reg.by_canonical).filter((c) =>
    c.toLowerCase().includes(needle),
  );
  if (matches.length === 1) {
    const canonical = matches[0];
    const meta = reg.by_canonical[canonical];
    return {
      kind: 'ok',
      canonical,
      handle: meta?.handle ?? '',
      name: meta?.name ?? null,
    };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', matches };
  }

  return { kind: 'not-found' };
}
