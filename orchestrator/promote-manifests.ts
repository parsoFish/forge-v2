/**
 * Shared manifest-promotion helper.
 *
 * Reads draft initiative manifests from a session's `manifests/` dir, validates
 * each, and writes them into `_queue/pending/`. Extracted from
 * `architect-commit.ts:doApprove` so the in-UI architect runner's finalize step
 * (ADR 020) and the legacy `forge architect commit` path share one code path —
 * the promotion rule must not drift between the two surfaces.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  parseManifest,
  validateManifest,
  writeManifest,
  type InitiativeManifest,
} from './manifest.ts';

export type PromoteManifestsResult = {
  writtenManifestPaths: string[];
  writtenInitiativeIds: string[];
};

/** Error codes mirror the legacy `ArchitectCommitError` codes so callers can
 *  surface identical operator-facing messages. */
export class PromoteManifestsError extends Error {
  code: 'NO_MANIFESTS' | 'INVALID_MANIFEST';
  constructor(code: 'NO_MANIFESTS' | 'INVALID_MANIFEST', message: string) {
    super(message);
    this.code = code;
    this.name = 'PromoteManifestsError';
  }
}

/**
 * Promote every `*.md` draft manifest in `manifestsDir` into
 * `<queueRoot>/pending/`. Throws `PromoteManifestsError` if the dir is missing,
 * empty, or any manifest fails validation (fail-fast at the boundary — a
 * half-promoted batch is worse than none).
 */
export function promoteManifests(
  manifestsDir: string,
  opts: { queueRoot: string },
): PromoteManifestsResult {
  if (!existsSync(manifestsDir)) {
    throw new PromoteManifestsError(
      'NO_MANIFESTS',
      `no manifests/ dir at ${manifestsDir}. The architect should have written drafts there.`,
    );
  }
  const manifestFiles = readdirSync(manifestsDir).filter((f) => f.endsWith('.md'));
  if (manifestFiles.length === 0) {
    throw new PromoteManifestsError('NO_MANIFESTS', `${manifestsDir} is empty.`);
  }

  const queueRoot = resolve(opts.queueRoot);
  const writtenManifestPaths: string[] = [];
  const writtenInitiativeIds: string[] = [];
  for (const file of manifestFiles) {
    const src = join(manifestsDir, file);
    const manifest: InitiativeManifest = parseManifest(readFileSync(src, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      throw new PromoteManifestsError(
        'INVALID_MANIFEST',
        `manifest ${src} invalid:\n  - ${errors.join('\n  - ')}`,
      );
    }
    const out = writeManifest(manifest, { queueRoot });
    writtenManifestPaths.push(out);
    writtenInitiativeIds.push(manifest.initiative_id);
  }
  return { writtenManifestPaths, writtenInitiativeIds };
}
