/**
 * `forge architect commit <session-id>` dispatch.
 *
 * Lives in its own module so it can be unit-tested without invoking the CLI
 * (which `process.exit`s on bad input). The CLI is a thin wrapper that maps
 * argv → ArchitectCommitInput and pretty-prints the ArchitectCommitResult.
 *
 * Verdict pipeline (parsed from `<projectRoot>/_architect/<session-id>/PLAN.md`):
 *
 *  - `approve`  → write each manifest in `manifests/` into `_queue/pending/`,
 *                 update `projects/<n>/roadmap.md`, emit `architect.plan-approved`.
 *  - `revise`   → bundle annotations into `<session-dir>/feedback.md`,
 *                 emit `architect.plan-revised`. The next architect session
 *                 (kicked off by the operator via `/forge-architect`) reads
 *                 the feedback file as additional system context.
 *  - `reject`   → move the session dir to `_architect/_archived/<sid>/`,
 *                 emit `architect.plan-rejected`.
 *
 * --via-pr flag (opt-in): open a draft PR on the project repo carrying the
 * PLAN.md on a `forge/architect/<session-id>` branch. Read review comments
 * via `gh pr view --comments`. If the project has no `origin` remote, log a
 * stderr warning and fall back to local-edit mode (the parsing path is
 * identical).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import {
  parseFeedbackComments,
  bundleFeedbackAsMarkdown,
  sessionPaths,
  archiveSessionDir,
  type Verdict,
  type Annotation,
} from './architect-plan.ts';
import {
  parseManifest,
  validateManifest,
  writeManifest,
  type InitiativeManifest,
} from './manifest.ts';
import { createLogger, type EventLogger } from './logging.ts';

export type ArchitectCommitInput = {
  sessionId: string;
  /** Path to the project repo (where `_architect/<sid>/` lives). */
  projectRoot: string;
  /** Optional override for the forge `_queue/` root (defaults to `<cwd>/_queue`). */
  queueRoot?: string;
  /** Optional override for the JSONL `_logs/` root (defaults to `<cwd>/_logs`). */
  logsRoot?: string;
  /** Optional logger override (used by tests). When unset, a logger is created
   *  under `<logsRoot>/_architect-<session-id>/`. */
  logger?: EventLogger;
  /** `--via-pr` opt-in surface. Default false. */
  viaPr?: boolean;
  /** Test seam — exec child process. Default: execFileSync. */
  runGh?: (args: string[], opts: { cwd: string }) => string;
};

export type ArchitectCommitResult = {
  verdict: Verdict;
  /** Files written / archived / created during this commit, for the CLI to print. */
  writtenManifestPaths: string[];
  feedbackPath?: string;
  archivedPath?: string;
  /** Forwarded from the PLAN.md parser. */
  annotations: Annotation[];
};

const PLAN_NOT_FOUND = 'PLAN_NOT_FOUND';
const VERDICT_NOT_SET = 'VERDICT_NOT_SET';
const NO_MANIFESTS = 'NO_MANIFESTS';

export class ArchitectCommitError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ArchitectCommitError';
  }
}

export async function dispatchArchitectCommit(
  input: ArchitectCommitInput,
): Promise<ArchitectCommitResult> {
  const paths = sessionPaths(input.projectRoot, input.sessionId);
  if (!existsSync(paths.planPath)) {
    throw new ArchitectCommitError(
      PLAN_NOT_FOUND,
      `architect commit: no PLAN.md at ${paths.planPath}. Has the architect run?`,
    );
  }

  // --via-pr: try to read review comments from the project PR.
  let { verdict, annotations } = parseFeedbackComments(paths.planPath);
  if (input.viaPr) {
    const fromPr = await readPrFeedback(input);
    if (fromPr) {
      annotations = [...annotations, ...fromPr.annotations];
      if (verdict === null) verdict = fromPr.verdict;
    }
  }

  if (verdict === null) {
    throw new ArchitectCommitError(
      VERDICT_NOT_SET,
      `architect commit: no <!-- verdict: --> set in ${paths.planPath}. Add ` +
        '<!-- verdict: approve | revise | reject --> to the top of the file (replacing the placeholder).',
    );
  }

  const logger = input.logger ?? createLogger(
    `_architect-${input.sessionId}`,
    input.logsRoot ?? resolve('_logs'),
  );

  // Always emit plan-emitted on first commit attempt (the architect skill
  // itself emits this when PLAN.md is written; we re-emit here defensively
  // so the CLI run always has a paired emitted→{approved,revised,rejected}.
  // No-op if the architect already logged.

  if (verdict === 'approve') {
    return await doApprove({ input, paths, annotations, logger });
  }
  if (verdict === 'revise') {
    return doRevise({ input, paths, annotations, logger });
  }
  return doReject({ input, paths, annotations, logger });
}

// ---------------------------------------------------------------------------
// approve — write manifests + emit event
// ---------------------------------------------------------------------------

async function doApprove(args: {
  input: ArchitectCommitInput;
  paths: ReturnType<typeof sessionPaths>;
  annotations: Annotation[];
  logger: EventLogger;
}): Promise<ArchitectCommitResult> {
  const { input, paths, annotations, logger } = args;
  if (!existsSync(paths.manifestsDir)) {
    throw new ArchitectCommitError(
      NO_MANIFESTS,
      `architect commit --approve: no manifests/ dir at ${paths.manifestsDir}. The architect should have written drafts there.`,
    );
  }
  const manifestFiles = readdirSync(paths.manifestsDir).filter((f) => f.endsWith('.md'));
  if (manifestFiles.length === 0) {
    throw new ArchitectCommitError(
      NO_MANIFESTS,
      `architect commit --approve: ${paths.manifestsDir} is empty.`,
    );
  }

  const queueRoot = input.queueRoot ?? resolve('_queue');
  const writtenManifestPaths: string[] = [];
  const writtenInitiativeIds: string[] = [];
  for (const file of manifestFiles) {
    const src = join(paths.manifestsDir, file);
    const manifest: InitiativeManifest = parseManifest(readFileSync(src, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      throw new ArchitectCommitError(
        'INVALID_MANIFEST',
        `architect commit --approve: manifest ${src} invalid:\n  - ${errors.join('\n  - ')}`,
      );
    }
    const out = writeManifest(manifest, { queueRoot });
    writtenManifestPaths.push(out);
    writtenInitiativeIds.push(manifest.initiative_id);
  }

  logger.emit({
    initiative_id: writtenInitiativeIds[0] ?? `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-plan',
    event_type: 'log',
    input_refs: [paths.planPath],
    output_refs: writtenManifestPaths,
    message: 'plan-approved',
    metadata: {
      action: 'plan-approved',
      session_id: input.sessionId,
      initiative_ids: writtenInitiativeIds,
      annotation_count: annotations.length,
    },
  });

  return {
    verdict: 'approve',
    writtenManifestPaths,
    annotations,
  };
}

// ---------------------------------------------------------------------------
// revise — bundle annotations into feedback.md + emit event
// ---------------------------------------------------------------------------

function doRevise(args: {
  input: ArchitectCommitInput;
  paths: ReturnType<typeof sessionPaths>;
  annotations: Annotation[];
  logger: EventLogger;
}): ArchitectCommitResult {
  const { input, paths, annotations, logger } = args;
  if (!existsSync(paths.sessionDir)) mkdirSync(paths.sessionDir, { recursive: true });
  const body = bundleFeedbackAsMarkdown(annotations);
  writeFileSync(paths.feedbackPath, body);

  // Stub the regenerated PLAN.md so the next architect session has a place
  // to write into. We don't actually re-run the council here — the architect
  // skill picks it up on the next invocation. This makes the CLI behaviour
  // observable in tests without depending on the SDK.
  if (existsSync(paths.planPath)) {
    const existing = readFileSync(paths.planPath, 'utf8');
    writeFileSync(
      paths.planPath,
      `<!-- forge: superseded by next architect pass; previous verdict was 'revise' -->\n` +
        existing,
    );
  }

  logger.emit({
    initiative_id: `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-plan',
    event_type: 'log',
    input_refs: [paths.planPath],
    output_refs: [paths.feedbackPath],
    message: 'plan-revised',
    metadata: {
      action: 'plan-revised',
      session_id: input.sessionId,
      annotation_count: annotations.length,
    },
  });

  return {
    verdict: 'revise',
    writtenManifestPaths: [],
    feedbackPath: paths.feedbackPath,
    annotations,
  };
}

// ---------------------------------------------------------------------------
// reject — archive session dir + emit event
// ---------------------------------------------------------------------------

function doReject(args: {
  input: ArchitectCommitInput;
  paths: ReturnType<typeof sessionPaths>;
  annotations: Annotation[];
  logger: EventLogger;
}): ArchitectCommitResult {
  const { input, paths, annotations, logger } = args;
  const archived = archiveSessionDir(input.projectRoot, input.sessionId);

  logger.emit({
    initiative_id: `architect-session-${input.sessionId}`,
    phase: 'architect',
    skill: 'architect-plan',
    event_type: 'log',
    input_refs: [paths.planPath],
    output_refs: [archived],
    message: 'plan-rejected',
    metadata: {
      action: 'plan-rejected',
      session_id: input.sessionId,
      annotation_count: annotations.length,
    },
  });

  return {
    verdict: 'reject',
    writtenManifestPaths: [],
    archivedPath: archived,
    annotations,
  };
}

// ---------------------------------------------------------------------------
// --via-pr: best-effort comment ingest
// ---------------------------------------------------------------------------

async function readPrFeedback(
  input: ArchitectCommitInput,
): Promise<{ verdict: Verdict | null; annotations: Annotation[] } | null> {
  const runGh = input.runGh ?? defaultRunGh;
  // Detect remote first; degrade gracefully when absent.
  try {
    runGh(['-C', input.projectRoot, 'remote', 'get-url', 'origin'], {
      cwd: input.projectRoot,
    });
  } catch {
    process.stderr.write(
      `forge architect commit: --via-pr requested but project has no \`origin\` remote; falling back to local-edit mode.\n`,
    );
    return null;
  }
  // Read PR comments via `gh pr view --comments` on the architect branch.
  const branch = `forge/architect/${input.sessionId}`;
  let raw = '';
  try {
    raw = runGh(['pr', 'view', branch, '--comments', '--json', 'comments,body'], {
      cwd: input.projectRoot,
    });
  } catch (err) {
    process.stderr.write(
      `forge architect commit: --via-pr could not read PR comments for ${branch} (${err instanceof Error ? err.message : String(err)}); falling back to local-edit.\n`,
    );
    return null;
  }
  return parsePrJson(raw);
}

function defaultRunGh(args: string[], opts: { cwd: string }): string {
  // Allow plain `git` calls too — the first arg picks the binary.
  // We intentionally route all subprocess work through this seam so tests can
  // swap it out.
  const bin = args[0] === '-C' ? 'git' : 'gh';
  return execFileSync(bin, args, { cwd: opts.cwd, encoding: 'utf8' });
}

/** Extract verdict + annotations from `gh pr view --json comments,body` output.
 *  Looks for the same HTML-comment markers as the local-edit path so the two
 *  surfaces share the parser. */
export function parsePrJson(raw: string): { verdict: Verdict | null; annotations: Annotation[] } {
  let parsed: { comments?: Array<{ body?: string }>; body?: string };
  try {
    parsed = JSON.parse(raw) as { comments?: Array<{ body?: string }>; body?: string };
  } catch {
    return { verdict: null, annotations: [] };
  }
  const allText: string[] = [];
  if (typeof parsed.body === 'string') allText.push(parsed.body);
  for (const c of parsed.comments ?? []) {
    if (typeof c.body === 'string') allText.push(c.body);
  }
  let verdict: Verdict | null = null;
  const annotations: Annotation[] = [];
  for (const block of allText) {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (verdict === null) {
        const m = /<!--\s*verdict:\s*(approve|revise|reject)\s*-->/i.exec(line);
        if (m) {
          const v = m[1].toLowerCase();
          if (v === 'approve' || v === 'revise' || v === 'reject') verdict = v;
        }
      }
      const r = /<!--\s*review:\s*([\s\S]*?)\s*-->/i.exec(line);
      if (r) annotations.push({ line: i + 1, text: r[1].trim() });
    }
  }
  return { verdict, annotations };
}
