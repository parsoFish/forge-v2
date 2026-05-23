/**
 * S6B — `forge reflect <id> --rerun` helper.
 *
 * Re-invokes `runReflector` against the closed manifest for `<id>`. The
 * reflector's user prompt already reads `_logs/<id>/user-feedback.md`, so
 * a rerun simply walks the existing stage-1→4 flow with the operator's
 * answers in place.
 *
 * Resolution rules for the manifest:
 *   1. `_queue/done/<id>.md`
 *   2. `_queue/ready-for-review/<id>.md`
 *   3. `_queue/in-flight/<id>.md`
 *   4. `_queue/failed/<id>.md`
 *
 * If none exist we throw with a clear message — rerun on a cycle whose
 * manifest is gone has nothing to reflect on.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runReflector } from './phases/reflector.ts';
import { createLogger } from './logging.ts';
import { parseManifest } from './manifest.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..');

export type RerunInput = {
  cycleId: string;
  /** Defaults to `<forge>/_logs`. */
  logsRoot?: string;
  /** Defaults to `<forge>/_queue`. */
  queueRoot?: string;
};

export async function rerunReflector(input: RerunInput): Promise<void> {
  const logsRoot = input.logsRoot ? resolve(input.logsRoot) : resolve(FORGE_ROOT, '_logs');
  const queueRoot = input.queueRoot ? resolve(input.queueRoot) : resolve(FORGE_ROOT, '_queue');

  // The cycleId IS the initiativeId in production cycles (see logging.ts +
  // reviewer manifest move semantics). Locate the manifest across the
  // terminal states.
  const candidates = [
    resolve(queueRoot, 'done', `${input.cycleId}.md`),
    resolve(queueRoot, 'ready-for-review', `${input.cycleId}.md`),
    resolve(queueRoot, 'in-flight', `${input.cycleId}.md`),
    resolve(queueRoot, 'failed', `${input.cycleId}.md`),
  ];
  const manifestPath = candidates.find((p) => existsSync(p));
  if (!manifestPath) {
    throw new Error(
      `rerun: no manifest for cycle ${input.cycleId} in ${queueRoot} (tried done/ready-for-review/in-flight/failed)`,
    );
  }

  const m = parseManifest(readFileSync(manifestPath, 'utf8'));
  const projectRepoPath =
    m.project_repo_path ?? resolve(FORGE_ROOT, 'projects', m.project);

  const logger = createLogger(input.cycleId, logsRoot);
  await runReflector(
    {
      initiativeId: m.initiative_id,
      manifestPath,
      projectRepoPath,
      worktreePath: projectRepoPath,
      cycleId: input.cycleId,
    },
    logger,
  );
}
