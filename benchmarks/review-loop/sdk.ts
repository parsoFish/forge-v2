/**
 * SDK invocation helper for the review-loop benchmark (stage 1).
 *
 * One call ≈ one reviewer-skill run against one fixture. Sets up an isolated
 * tempdir, copies the fixture's seed worktree into `projects/<name>/`, drops
 * the manifest into `_queue/in-flight/`, and invokes the agent via the
 * Claude Agent SDK with the contract from `orchestrator/reviewer-invocation.ts`.
 *
 * Why isolated tempdirs (vs running against the live repo): each fixture's
 * agent writes a demo bundle and a PR description into `.forge/`, and the
 * bench must produce deterministic, comparable runs. Symlinks make brain/,
 * skills/, docs/, orchestrator/, loops/ available to the agent without
 * copying.
 *
 * Why the `gh` PATH-stub: the reviewer's tool whitelist includes Bash. In
 * live mode the orchestrator calls `gh pr create`; in bench mode the agent
 * must NOT open real PRs even if it ignores the prompt rule. The stub binary
 * exits non-zero so any `gh` invocation fails fast instead of burning the
 * fixture's budget retrying. Backup defenses: `GH_TOKEN=invalid` and the
 * tempdir is not a git repo with a real GitHub remote.
 *
 * Why the `vhs` and `playwright` PATH-shims: real VHS requires ffmpeg+ttyd
 * (extra system deps), and real Playwright requires a 200MB+ browser bundle.
 * Neither belongs in the bench's hot loop. The shims accept the same argv as
 * the real tools and produce a valid stub recording (correct magic bytes for
 * mp4 / trace.zip, padded to 60 KB so it clears the 50 KB size floor). The
 * shim's output exercises the bench rubric exactly the same way real output
 * would: `demoRecordingPresent()` validates magic bytes + size; the source
 * script (the agent's actual contribution) is unchanged. In production,
 * operators install real VHS / Playwright — the agent invokes them the same
 * way; the orchestrator does NOT add these shims.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  REVIEWER_ALLOWED_TOOLS,
  REVIEWER_DISALLOWED_TOOLS,
  REVIEWER_MODEL,
  buildReviewerSystemPrompt,
  renderReviewerUserPrompt,
  tallyToolUse,
  type ReviewerToolUseSummary,
} from '../../orchestrator/reviewer-invocation.ts';
import { readWorkItemsFromDir, type WorkItem } from '../../orchestrator/work-item.ts';

const FORGE_ROOT = resolve(import.meta.dirname, '..', '..');

export type ReviewerQueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export type RunReviewerInput = {
  fixtureId: string;
  initiativeId: string;
  /**
   * Absolute path to the fixture's seed tree (a directory under
   * benchmarks/review-loop/fixtures/<id>/branch-state/). Copied recursively
   * into <tempdir>/projects/<projectName>/. Must contain `.forge/work-items/`
   * with all WIs at status: complete.
   */
  seedTreePath: string;
  /** Absolute path to the manifest file. Copied into <tempdir>/_queue/in-flight/. */
  manifestPath: string;
  projectName: string;
  /** Project type — informs the agent's demo-tool decision. */
  projectType: 'browser' | 'cli' | 'lib' | 'rest';
  /** Quality gate command argv — the bench runs this AFTER the agent finishes. */
  qualityGateCmd: string[];
  /** Whether the fixture is set up as a stacked PR (parents present in the manifest). */
  isStackedPr: boolean;
  /** Max session turns before the SDK aborts. Default 30. */
  maxTurns?: number;
  /** Cost budget in USD. Default 0.6. */
  maxBudgetUsd?: number;
  /** Inject a fake `query` for testing. */
  queryFn?: ReviewerQueryFn;
};

export type ReviewerRunnerErrorKind =
  | 'manifest_missing'
  | 'seed_missing'
  | 'agent_threw'
  | 'work_items_unreadable'
  | 'unknown_error';

export type RunReviewerResult = {
  tempdir: string;
  worktreePath: string;
  manifestRelPath: string;
  worktreeRelPath: string;
  workItems: WorkItem[];
  durationMs: number;
  costUsd: number;
  toolUseSummary: ReviewerToolUseSummary;
  /** Quality gate exit-zero status from the post-agent verification. */
  qualityGatesPassed: boolean;
  /** SDK message subtype on the result event ('success' | 'error_max_turns' | …). */
  resultSubtype?: string;
  runnerError?: { kind: ReviewerRunnerErrorKind; message: string };
};

/**
 * Set up an isolated tempdir for one bench run.
 *
 * Layout (matches the live forge root the agent expects to navigate):
 *   <tempdir>/
 *     brain/           → symlink (ro) into FORGE_ROOT/brain
 *     skills/          → symlink
 *     docs/            → symlink
 *     orchestrator/    → symlink
 *     loops/           → symlink
 *     projects/<name>/ → recursive copy of seedTreePath (the worktree)
 *     _queue/in-flight/<initiative-id>.md → copy of manifestPath
 *     bin/gh           → executable stub that exits 1 (PATH defense)
 */
export function setupTempdir(input: RunReviewerInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-review-'));

  for (const sub of ['brain', 'skills', 'docs', 'orchestrator', 'loops']) {
    symlinkSync(resolve(FORGE_ROOT, sub), resolve(dir, sub));
  }

  if (!existsSync(input.seedTreePath)) {
    throw new Error(`seed tree path does not exist: ${input.seedTreePath}`);
  }
  const projDir = resolve(dir, 'projects', input.projectName);
  mkdirSync(projDir, { recursive: true });
  cpSync(input.seedTreePath, projDir, { recursive: true });

  if (!existsSync(input.manifestPath)) {
    throw new Error(`manifest path does not exist: ${input.manifestPath}`);
  }
  const queueDir = resolve(dir, '_queue', 'in-flight');
  mkdirSync(queueDir, { recursive: true });
  cpSync(input.manifestPath, resolve(queueDir, `${input.initiativeId}.md`));

  const binDir = resolve(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // gh stub: defense-in-depth against an agent that ignores the prompt rule
  // and tries to open a real PR. The stub exits non-zero; the agent's prompt
  // already says "do NOT call gh pr create".
  const ghStub = resolve(binDir, 'gh');
  writeFileSync(
    ghStub,
    '#!/bin/sh\necho "[bench] gh disabled — orchestrator owns gh pr create" >&2\nexit 1\n',
  );
  chmodSync(ghStub, 0o755);

  // vhs shim: parses `vhs <tape> -o <out>` (or `vhs <tape>` -> output.gif by
  // default) and writes a valid stub mp4/gif/webm with proper magic bytes,
  // padded to ≥ 60 KB so the size floor passes. Does NOT actually render the
  // .tape — bench tests workflow, not rendering fidelity.
  const vhsShim = resolve(binDir, 'vhs');
  writeFileSync(vhsShim, VHS_SHIM_SCRIPT);
  chmodSync(vhsShim, 0o755);

  // playwright shim: handles `npx playwright test ...` indirectly via npx.
  // We override `npx` to detect "playwright" subcommands and write a stub
  // trace.zip / video file accordingly. Other npx invocations fall through.
  const npxShim = resolve(binDir, 'npx');
  writeFileSync(npxShim, NPX_SHIM_SCRIPT);
  chmodSync(npxShim, 0o755);

  return dir;
}

/**
 * The shims are tiny node scripts that write binary headers correctly using
 * Buffer literals — sh `printf` with `\x` escapes is non-portable across
 * /bin/sh implementations (dash skips them silently). Node is already a
 * dependency since forge runs on it.
 */
const VHS_SHIM_SCRIPT = `#!/usr/bin/env node
// vhs shim for forge review-loop bench. Writes a stub recording with valid
// magic bytes, ≥ 60 KB, in the cwd or -o location. Does not render.
// Usage: vhs <tape> [-o <output>]
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
let tape = '';
let out = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--output') { out = argv[++i] ?? ''; continue; }
  if (a === '-t' || a === '--theme' || a === '-q' || a === '--quiet') {
    if (a !== '-q' && a !== '--quiet') i += 1;
    continue;
  }
  if (a.startsWith('-')) continue;
  if (!tape) tape = a;
}
if (!tape) { process.stderr.write('vhs shim: missing tape argument\\n'); process.exit(2); }
if (!out) out = path.join(process.cwd(), 'out.gif');
if (!path.isAbsolute(out)) out = path.resolve(process.cwd(), out);
fs.mkdirSync(path.dirname(out), { recursive: true });
const ext = out.toLowerCase();
let header;
if (ext.endsWith('.mp4') || ext.endsWith('.m4v')) {
  // ftyp box at offset 0; size=32, type='ftyp', major_brand='isom'
  header = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2avc1mp41', 'ascii'),
  ]);
} else if (ext.endsWith('.webm')) {
  header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
} else {
  // default: gif
  header = Buffer.from('GIF89a', 'ascii');
}
const padding = Buffer.alloc(65536, 0xaa);
fs.writeFileSync(out, Buffer.concat([header, padding]));
process.stderr.write(\`[vhs shim] recorded \${tape} -> \${out}\\n\`);
process.exit(0);
`;

const NPX_SHIM_SCRIPT = `#!/usr/bin/env node
// npx shim for forge review-loop bench. Recognises Playwright invocations and
// emits a stub trace.zip in the agent's cwd; everything else exits non-zero
// (the bench has no other npx use case).
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const isPlaywright = argv.some((a) => a.includes('playwright'));
if (!isPlaywright) {
  process.stderr.write('[npx shim] only playwright subcommands supported in bench\\n');
  process.exit(1);
}
// Default output path: <cwd>/recording.trace.zip
const out = path.resolve(process.cwd(), 'recording.trace.zip');
fs.mkdirSync(path.dirname(out), { recursive: true });
// PK\\x03\\x04 (zip local file header) + minimal padding to clear size floor.
const header = Buffer.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
]);
const padding = Buffer.alloc(65536, 0xaa);
fs.writeFileSync(out, Buffer.concat([header, padding]));
process.stderr.write(\`[npx shim] playwright recording -> \${out}\\n\`);
process.exit(0);
`;

export function cleanupTempdir(tempdir: string): void {
  try {
    rmSync(tempdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Run the orchestrator-verified quality gate. Bench truth, not agent claim.
 * Returns true iff the command exits 0 in the worktree.
 */
export function runQualityGate(worktreePath: string, cmd: string[]): boolean {
  if (cmd.length === 0) {
    throw new Error('quality_gate_cmd must have at least one argv element');
  }
  const [head, ...rest] = cmd;
  if (!head) return false;
  try {
    execFileSync(head, rest, { cwd: worktreePath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runReviewer(input: RunReviewerInput): Promise<RunReviewerResult> {
  const tempdir = setupTempdir(input);
  const worktreePath = resolve(tempdir, 'projects', input.projectName);
  const manifestRelPath = `_queue/in-flight/${input.initiativeId}.md`;
  const worktreeRelPath = `projects/${input.projectName}`;
  const workItemsDir = resolve(worktreePath, '.forge', 'work-items');

  const toolUseSummary: ReviewerToolUseSummary = {
    brainReads: 0,
    writes: 0,
    bashCalls: 0,
    recorderInvocations: 0,
  };

  let workItems: WorkItem[] = [];
  try {
    const { items, parseErrors } = readWorkItemsFromDir(workItemsDir);
    const errorEntries = Object.entries(parseErrors);
    if (errorEntries.length > 0) {
      return {
        tempdir,
        worktreePath,
        manifestRelPath,
        worktreeRelPath,
        workItems: [],
        durationMs: 0,
        costUsd: 0,
        toolUseSummary,
        qualityGatesPassed: false,
        runnerError: {
          kind: 'work_items_unreadable',
          message: errorEntries.map(([path, msg]) => `${path}: ${msg}`).join('; '),
        },
      };
    }
    if (items.length === 0) {
      return {
        tempdir,
        worktreePath,
        manifestRelPath,
        worktreeRelPath,
        workItems: [],
        durationMs: 0,
        costUsd: 0,
        toolUseSummary,
        qualityGatesPassed: false,
        runnerError: {
          kind: 'work_items_unreadable',
          message: `no work items found at ${workItemsDir}`,
        },
      };
    }
    workItems = items;
  } catch (err) {
    return {
      tempdir,
      worktreePath,
      manifestRelPath,
      worktreeRelPath,
      workItems: [],
      durationMs: 0,
      costUsd: 0,
      toolUseSummary,
      qualityGatesPassed: false,
      runnerError: {
        kind: 'work_items_unreadable',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const queryFn: ReviewerQueryFn = input.queryFn ?? (sdkQuery as unknown as ReviewerQueryFn);

  const systemPrompt = buildReviewerSystemPrompt(tempdir);
  const prompt = renderReviewerUserPrompt({
    initiativeId: input.initiativeId,
    manifestRelPath,
    worktreeRelPath,
    projectName: input.projectName,
    projectType: input.projectType,
    qualityGateCmd: input.qualityGateCmd.join(' '),
    isStackedPr: input.isStackedPr,
  });

  const options: Record<string, unknown> = {
    cwd: tempdir,
    systemPrompt,
    model: REVIEWER_MODEL,
    permissionMode: 'acceptEdits',
    allowedTools: [...REVIEWER_ALLOWED_TOOLS],
    disallowedTools: [...REVIEWER_DISALLOWED_TOOLS],
    maxTurns: input.maxTurns ?? 50,
    maxBudgetUsd: input.maxBudgetUsd ?? 0.6,
    env: {
      // Inherit but override: the gh stub takes precedence, and the token is
      // intentionally invalid so any indirect gh-via-PATH route still fails.
      ...process.env,
      PATH: `${resolve(tempdir, 'bin')}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'invalid',
    },
  };

  const startedAt = Date.now();
  let durationMs = 0;
  let costUsd = 0;
  let resultSubtype: string | undefined;
  let runnerError: RunReviewerResult['runnerError'];

  try {
    for await (const msg of queryFn({ prompt, options })) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as {
        type?: string;
        message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
        subtype?: string;
        duration_ms?: number;
        total_cost_usd?: number;
      };
      if (m.type === 'assistant') {
        tallyToolUse(m.message, toolUseSummary);
        continue;
      }
      if (m.type !== 'result') continue;
      if (typeof m.duration_ms === 'number') durationMs = m.duration_ms;
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
      resultSubtype = m.subtype ?? 'success';
      break;
    }
  } catch (err) {
    runnerError = {
      kind: 'agent_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (durationMs === 0) durationMs = Date.now() - startedAt;

  const qualityGatesPassed = runQualityGate(worktreePath, input.qualityGateCmd);

  return {
    tempdir,
    worktreePath,
    manifestRelPath,
    worktreeRelPath,
    workItems,
    durationMs,
    costUsd,
    toolUseSummary,
    qualityGatesPassed,
    resultSubtype,
    runnerError,
  };
}
