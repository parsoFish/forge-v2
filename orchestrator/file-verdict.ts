/**
 * File-based verdict provider for the review-loop's stage-2 gate.
 *
 * The reviewer's `GetVerdict` is called between Ralph iterations; production
 * needs a way to surface the verdict request to the human operator without
 * blocking the scheduler on stdin (which would prevent it from doing
 * anything else, and rules out headless / remote operation).
 *
 * Protocol — file-based, mirrors the reflector's user-questions/feedback
 * pattern:
 *
 *   1. `<queueRoot>/in-flight/<initiativeId>.verdict-prompt.md` is written
 *      with the verdict context (PR draft path, demo bundle path, diff
 *      summary, work-item list, round number).
 *   2. A `review-ready` notification fires telling the operator to run
 *      `forge review <initiativeId>` (or hand-edit the response file).
 *   3. The provider polls every `pollIntervalMs` for
 *      `<queueRoot>/in-flight/<initiativeId>.verdict-response.md`.
 *   4. On detection, the response is parsed (frontmatter + optional ACs),
 *      the prompt + response files are deleted, and the verdict returned.
 *
 * The operator-facing CLI (`forge review`) writes the response file. So
 * does any human who hand-edits — the format is a stable markdown contract.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { notify, type NotifyConfig } from './notify.ts';
import type { AcceptanceCriterion, WorkItem } from './work-item.ts';

/**
 * Verdict shape — the operator's response to the review prompt. Migrated from
 * the (deleted) `reviewer-stage2.ts` module during S4: the verdict-shape
 * types live next to the file-verdict transport that produces them.
 */
export type Verdict =
  | { kind: 'approve'; rationale: string }
  | { kind: 'send-back'; feedback: AcceptanceCriterion[]; rationale: string };

/**
 * Context the verdict-provider sees when asked for a verdict. The review
 * router (S4) builds this from the open PR's state when running the
 * file-based provider as a fallback to PR-comment polling.
 */
export type VerdictContext = {
  initiativeId: string;
  worktreePath: string;
  manifestPath: string;
  /** Absolute path to `<worktree>/.forge/pr-description.md`. */
  prDescriptionPath: string;
  /** Absolute path to the tracked demo bundle directory. */
  demoBundleDir: string;
  workItems: WorkItem[];
  /** `git diff main...HEAD --stat` output, capped at ~4 KB. */
  diffSummary: string;
  /** 1 = first review (after iteration 1); 2 = after iteration 2; ... */
  roundNumber: number;
};

export type GetVerdict = (ctx: VerdictContext) => Promise<Verdict>;

export type FileVerdictPaths = {
  promptPath: string;
  responsePath: string;
};

export type FileVerdictOptions = {
  initiativeId: string;
  /** Defaults to `_queue` (resolved from cwd). */
  queueRoot?: string;
  /** Default 5_000 (5 s). */
  pollIntervalMs?: number;
  /** Default Infinity — operators may take hours. Set in tests. */
  timeoutMs?: number;
  /** Notification config (operator gets a desktop ping when prompt is written). */
  notifier?: NotifyConfig;
  /**
   * Hook invoked after the prompt is written and before polling. Used by
   * the scheduler to log the prompt path and by tests to know when to drop
   * a response file.
   */
  onPrompt?: (paths: FileVerdictPaths) => void | Promise<void>;
};

/**
 * Resolve the standard file-verdict paths for an initiative. Pure — no I/O.
 * The CLI uses this to know where to read/write.
 */
export function fileVerdictPaths(
  initiativeId: string,
  queueRoot = '_queue',
): FileVerdictPaths {
  const inFlight = resolve(queueRoot, 'in-flight');
  return {
    promptPath: resolve(inFlight, `${initiativeId}.verdict-prompt.md`),
    responsePath: resolve(inFlight, `${initiativeId}.verdict-response.md`),
  };
}

/**
 * Build a `GetVerdict` that writes a prompt file, notifies the operator,
 * and polls for a response file. See module docstring for the contract.
 */
export function makeFileVerdict(opts: FileVerdictOptions): GetVerdict {
  const queueRoot = opts.queueRoot ?? '_queue';
  const paths = fileVerdictPaths(opts.initiativeId, queueRoot);
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? Number.POSITIVE_INFINITY;

  return async (ctx: VerdictContext): Promise<Verdict> => {
    mkdirSync(dirname(paths.promptPath), { recursive: true });
    writeFileSync(paths.promptPath, renderVerdictPrompt(ctx, paths));

    if (opts.notifier) {
      await notify(
        {
          type: 'review-ready',
          title: `Review needed: ${ctx.initiativeId}`,
          body: `Round ${ctx.roundNumber} — run: forge review ${ctx.initiativeId}`,
        },
        opts.notifier,
      ).catch(() => {
        /* best-effort */
      });
    }

    if (opts.onPrompt) await opts.onPrompt(paths);

    const start = Date.now();
    while (true) {
      if (existsSync(paths.responsePath)) {
        // Read + parse can both throw (TOCTOU on the file removal between
        // existsSync and readFileSync; malformed YAML / unknown verdict
        // kind / send-back without ACs). Always clean up before exiting,
        // and re-throw the parse error so the operator sees the rejection
        // rather than the cycle silently stalling on a bad response file.
        let text: string;
        try {
          text = readFileSync(paths.responsePath, 'utf8');
        } catch {
          // File vanished between existsSync and readFileSync; keep polling.
          await sleep(pollIntervalMs);
          continue;
        }
        try {
          const verdict = parseVerdictResponse(text);
          cleanup(paths);
          return verdict;
        } catch (parseErr) {
          cleanup(paths);
          throw parseErr;
        }
      }
      if (Date.now() - start > timeoutMs) {
        cleanup(paths);
        throw new Error(
          `file-verdict: timed out after ${timeoutMs}ms waiting for ${paths.responsePath}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  };
}

function cleanup(paths: FileVerdictPaths): void {
  for (const p of [paths.promptPath, paths.responsePath]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Render the markdown the operator reads to produce a verdict. Includes
 * file paths (PR draft, demo bundle), the round number, and the list of
 * work items being reviewed.
 */
export function renderVerdictPrompt(
  ctx: VerdictContext,
  paths: FileVerdictPaths,
): string {
  const wis = ctx.workItems
    .map((wi) => `- ${wi.work_item_id} (${wi.status}) — feature ${wi.feature_id}`)
    .join('\n');

  return `---
initiative_id: ${ctx.initiativeId}
round_number: ${ctx.roundNumber}
prompt_path: ${paths.promptPath}
response_path: ${paths.responsePath}
---

# Review verdict needed — ${ctx.initiativeId} (round ${ctx.roundNumber})

The reviewer agent has produced (or refined) the demo + PR draft. Inspect
the artefacts and write a verdict to:

\`${paths.responsePath}\`

## Artefacts to review

- **PR description draft:** \`${ctx.prDescriptionPath}\`
- **Demo bundle:** \`${ctx.demoBundleDir}\`
- **Worktree:** \`${ctx.worktreePath}\`

## Work items in this initiative

${wis || '_(none)_'}

## Diff summary (vs. main)

\`\`\`
${ctx.diffSummary.trim()}
\`\`\`

## How to respond

Run \`forge review ${ctx.initiativeId}\` for an interactive prompt, or write
the response file directly using one of these formats.

### To approve

\`\`\`yaml
---
verdict: approve
rationale: |
  Brief reason why this is mergeable.
---
\`\`\`

### To send back

\`\`\`yaml
---
verdict: send-back
rationale: |
  Why the work isn't done yet.
---

## Acceptance criteria

- GIVEN <precondition> WHEN <action> THEN <expected outcome>
- GIVEN ... WHEN ... THEN ...
\`\`\`

The reviewer-Ralph reads the new acceptance criteria from \`fix_plan.md\`
on the next iteration and addresses them. Send-back cap is 2 rounds (3
iterations total = 1 prep + 2 send-back).
`;
}

/**
 * Parse the operator's response file into a `Verdict`. Tolerates leading
 * whitespace and CRLF line endings; rejects unknown verdict kinds.
 */
export function parseVerdictResponse(text: string): Verdict {
  const fmMatch = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('verdict-response: missing YAML frontmatter');
  }
  const fm = parseFrontmatter(fmMatch[1]);
  const body = fmMatch[2] ?? '';

  const kind = fm.verdict?.trim();
  const rationale = (fm.rationale ?? '').trim();

  if (kind === 'approve') {
    return { kind: 'approve', rationale };
  }
  if (kind === 'send-back') {
    const feedback = parseAcceptanceCriteria(body);
    if (feedback.length === 0) {
      throw new Error(
        'verdict-response: send-back must include at least one acceptance criterion (- GIVEN ... WHEN ... THEN ...)',
      );
    }
    return { kind: 'send-back', feedback, rationale };
  }
  throw new Error(`verdict-response: unknown verdict kind: ${kind ?? '(empty)'}`);
}

/**
 * Minimal YAML frontmatter parser. Supports `key: value` and `key: |` block
 * scalars. Sufficient for the verdict-response shape; not a general parser.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const blockMatch = line.match(/^(\w+):\s*\|\s*$/);
    if (blockMatch) {
      const key = blockMatch[1];
      i += 1;
      const blockLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.length === 0) {
          blockLines.push('');
          i += 1;
          continue;
        }
        if (/^\s/.test(l)) {
          blockLines.push(l.replace(/^\s{1,2}/, ''));
          i += 1;
          continue;
        }
        break;
      }
      out[key] = blockLines.join('\n');
      continue;
    }
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      out[kvMatch[1]] = kvMatch[2];
    }
    i += 1;
  }
  return out;
}

/**
 * Parse acceptance-criterion bullet lines from a markdown body. Tolerates
 * the `- AC:` prefix that mirrors the prior reviewer-stage2 send-back
 * format, plus a plain `- GIVEN` form. Exported for the review router
 * (S4) which uses it to scrape ACs from PR-level review comments.
 */
export function parseAcceptanceCriteria(body: string): AcceptanceCriterion[] {
  const acs: AcceptanceCriterion[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const match =
      line.match(/^-\s+AC:\s+GIVEN\s+(.+?)\s+WHEN\s+(.+?)\s+THEN\s+(.+)$/i) ??
      line.match(/^-\s+GIVEN\s+(.+?)\s+WHEN\s+(.+?)\s+THEN\s+(.+)$/i);
    if (match) {
      acs.push({
        given: match[1].trim(),
        when: match[2].trim(),
        then: match[3].trim(),
      });
    }
  }
  return acs;
}
