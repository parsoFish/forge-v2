#!/usr/bin/env node
/**
 * forge CLI. Subcommands:
 *   forge serve [--once]                    run the scheduler
 *   forge cycle <initiative-id>             run one initiative end-to-end (foreground)
 *   forge enqueue <project> <spec>          drop a manifest into _queue/pending/
 *   forge enqueue --from-manifest <path>    validate + drop a pre-formed manifest
 *   forge enqueue --fixture                 drop a smoke-test fixture
 *   forge status [--watch]                  print queue + in-flight snapshot
 *   forge metrics [<cycle-id>]              print per-cycle aggregates (or all)
 *   forge bench <phase>                     run a phase's benchmark suite
 *   forge brain query "..."                 stub: invoke brain-query skill
 *   forge brain index [--scope <project>]   emit the brain navigation indexes (cache-friendly prefix)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runCycle } from './cycle.ts';
import { serve, status as schedulerStatus } from './scheduler.ts';
import { snapshot, render } from './visualise.ts';
import { summariseCycle, summariseAll } from './metrics.ts';
import { getPaths } from './queue.ts';
import { parseManifest, validateManifest, writeManifest } from './manifest.ts';
import { loadBrainIndex } from './brain-index.ts';
import { fileVerdictPaths } from './file-verdict.ts';
import { assertEnv } from './config.ts';
import { writeCycleReport } from './cycle-report.ts';

const args = process.argv.slice(2);
const cmd = args[0];

(async () => {
  // F-10: surface env-setup issues at every CLI invocation (warn-only;
  // some setups — e.g., Claude Code — provide auth via credentials file).
  // Verbs that don't talk to the SDK (status, metrics, brain index, --help)
  // skip the warning to keep their output clean.
  const sdkVerbs = new Set(['serve', 'cycle']);
  if (cmd && sdkVerbs.has(cmd)) assertEnv('warn');

  switch (cmd) {
    case 'serve':
      return await cmdServe(args.slice(1));
    case 'cycle':
      return await cmdCycle(args.slice(1));
    case 'enqueue':
      return cmdEnqueue(args.slice(1));
    case 'status':
      return cmdStatus(args.slice(1));
    case 'metrics':
      return cmdMetrics(args.slice(1));
    case 'review':
      return cmdReview(args.slice(1));
    case 'report':
      return cmdReport(args.slice(1));
    case 'bench':
      return cmdBench(args.slice(1));
    case 'brain':
      return cmdBrain(args.slice(1));
    case '--help':
    case '-h':
    case undefined:
      return cmdHelp();
    default:
      console.error(`unknown command: ${cmd}`);
      cmdHelp();
      process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function cmdHelp(): void {
  console.log(
    `forge — autonomous multi-agent orchestrator

Usage:
  forge serve [--once]                    Start the unattended scheduler
  forge cycle <initiative-id>             Run one initiative end-to-end (foreground)
  forge enqueue <project> <spec>          Drop an initiative manifest into _queue/pending/
  forge enqueue --from-manifest <path>    Validate + drop a pre-formed manifest
  forge enqueue --fixture                 Drop a smoke-test fixture into _queue/pending/
  forge status [--watch]                  Print queue + in-flight snapshot
  forge metrics [<cycle-id>]              Per-cycle aggregates (or all cycles)
  forge review <initiative-id>            Print the open verdict prompt and the response file's path
  forge report <cycle-id> [--regenerate]  Print (or regenerate) the human-facing cycle report
  forge bench <phase>                     Run a phase's benchmark suite (alias for npm run bench:<phase>)
  forge brain query "<question>"          Query the brain (skeleton)
  forge brain index [--scope <project>]   Emit the brain navigation indexes as a single blob (cache-friendly prefix for prompts)

For phase-implementation guidance see docs/phases/. For decisions see docs/decisions/.`,
  );
}

async function cmdServe(rest: string[]): Promise<void> {
  const once = rest.includes('--once');
  console.log(once ? 'forge serve --once: claiming one initiative…' : 'forge serve: starting…');
  await serve({ mode: once ? 'once' : 'forever' });
}

async function cmdCycle(rest: string[]): Promise<void> {
  const initiativeId = rest[0];
  const dryRun = rest.includes('--dry-run');
  if (!initiativeId) {
    console.error('forge cycle: missing <initiative-id>');
    process.exit(2);
  }
  // For dry runs, we can synthesise paths; for real runs the manifest must
  // exist in _queue/in-flight/.
  const paths = getPaths();
  const manifestPath = join(paths.inFlight, `${initiativeId}.md`);
  const projectRepoPath = resolve('projects', initiativeId);
  const worktreePath = resolve('_worktrees', initiativeId);
  const result = await runCycle({
    initiativeId,
    manifestPath,
    projectRepoPath,
    worktreePath,
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

function cmdEnqueue(rest: string[]): void {
  const paths = getPaths();
  if (!existsSync(paths.pending)) mkdirSync(paths.pending, { recursive: true });

  if (rest[0] === '--from-manifest') {
    const src = rest[1];
    if (!src) {
      console.error('forge enqueue --from-manifest: missing <path>');
      process.exit(2);
    }
    if (!existsSync(src)) {
      console.error(`forge enqueue --from-manifest: file not found: ${src}`);
      process.exit(2);
    }
    const manifest = parseManifest(readFileSync(src, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      console.error(`forge enqueue --from-manifest: invalid manifest:\n  - ${errors.join('\n  - ')}`);
      process.exit(2);
    }
    const out = writeManifest(manifest);
    console.log(`enqueued: ${out}`);
    return;
  }

  if (rest[0] === '--fixture') {
    // Bootstrap a tiny throwaway git repo at projects/fixture/ so the scheduler
    // can `git worktree add` against it and complete the (no-op) cycle, ending
    // up in _queue/ready-for-review/ instead of failing on missing-repo.
    const fixtureRepo = resolve('projects', 'fixture');
    if (!existsSync(fixtureRepo)) {
      mkdirSync(fixtureRepo, { recursive: true });
      execSync(
        `git -C "${fixtureRepo}" init -q -b main && \
         git -C "${fixtureRepo}" -c user.email=fixture@forge -c user.name=fixture commit -q --allow-empty -m "fixture: initial"`,
        { stdio: 'pipe' },
      );
    }
    const id = `INIT-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-fixture`;
    const manifest = `---
initiative_id: ${id}
project: fixture
project_repo_path: ${fixtureRepo}
created_at: ${new Date().toISOString()}
iteration_budget: 5
cost_budget_usd: 1.00
phase: pending
features:
  - feature_id: FEAT-1
    title: smoke-test feature
    depends_on: []
---

# Fixture initiative

Smoke test for the scheduler. No real work performed.
`;
    const out = join(paths.pending, `${id}.md`);
    writeFileSync(out, manifest);
    console.log(`enqueued: ${out}`);
    return;
  }

  const project = rest[0];
  const specPath = rest[1];
  if (!project || !specPath) {
    console.error('forge enqueue: usage: enqueue <project> <spec-path> | enqueue --fixture');
    process.exit(2);
  }
  const id = `INIT-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${project}`;
  const body = readFileSync(specPath, 'utf8');
  const manifest = `---
initiative_id: ${id}
project: ${project}
created_at: ${new Date().toISOString()}
iteration_budget: 50
cost_budget_usd: 25.00
phase: pending
---

${body}`;
  const out = join(paths.pending, `${id}.md`);
  writeFileSync(out, manifest);
  console.log(`enqueued: ${out}`);
}

function cmdStatus(rest: string[]): void {
  const watch = rest.includes('--watch');
  const print = (): void => {
    const snap = snapshot();
    if (watch) console.clear();
    console.log(render(snap));
    if (!watch) {
      const c = schedulerStatus().counts;
      console.log(`\n(totals: ${JSON.stringify(c)})`);
    }
  };
  print();
  if (watch) setInterval(print, 2000);
}

function cmdReview(rest: string[]): void {
  const initiativeId = rest[0];
  if (!initiativeId) {
    console.error('forge review: missing <initiative-id>');
    console.error('Usage: forge review <initiative-id>');
    process.exit(2);
  }
  const paths = fileVerdictPaths(initiativeId);
  if (!existsSync(paths.promptPath)) {
    console.error(`forge review: no open verdict prompt at ${paths.promptPath}`);
    console.error('No initiative is currently waiting for review under that ID.');
    console.error('Run `forge status` to see what\'s in flight.');
    process.exit(2);
  }
  process.stdout.write(readFileSync(paths.promptPath, 'utf8'));
  console.log('---');
  console.log(`Write your verdict to: ${paths.responsePath}`);
  if (existsSync(paths.responsePath)) {
    console.log('(a response file already exists; the scheduler will pick it up shortly)');
  } else {
    console.log('(use the templates above as a starting point)');
  }
}

function cmdReport(rest: string[]): void {
  const cycleId = rest[0];
  if (!cycleId) {
    console.error('forge report: missing <cycle-id>');
    console.error('Usage: forge report <cycle-id> [--regenerate]');
    console.error('Run `forge metrics` to list cycle IDs.');
    process.exit(2);
  }
  const reportPath = join('_logs', cycleId, 'report.md');
  const regenerate = rest.includes('--regenerate') || !existsSync(reportPath);
  if (regenerate) {
    try {
      writeCycleReport({ cycleId });
    } catch (err) {
      console.error(`forge report: failed to generate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (!existsSync(reportPath)) {
    console.error(`forge report: no report at ${reportPath}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(reportPath, 'utf8'));
}

function cmdMetrics(rest: string[]): void {
  if (rest[0]) {
    console.log(JSON.stringify(summariseCycle(rest[0]), null, 2));
  } else {
    console.log(JSON.stringify(summariseAll(), null, 2));
  }
}

function cmdBench(rest: string[]): void {
  const phase = rest[0];
  if (!phase) {
    console.error('forge bench: usage: bench <phase>');
    process.exit(2);
  }
  console.log(`Run via: npm run bench:${phase}`);
}

function cmdBrain(rest: string[]): void {
  const sub = rest[0];
  if (sub === 'index') return cmdBrainIndex(rest.slice(1));
  if (sub === 'query') return cmdBrainQueryStub(rest.slice(1));
  console.error('forge brain: subcommands: index, query');
  process.exit(2);
}

function cmdBrainIndex(rest: string[]): void {
  const scopeIdx = rest.indexOf('--scope');
  const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] ?? null : null;
  process.stdout.write(loadBrainIndex({ scope }) + '\n');
}

function cmdBrainQueryStub(rest: string[]): void {
  const question = rest.join(' ');
  console.log(`(skeleton) brain-query: "${question}"`);
  console.log('Wire the brain-query skill via @anthropic-ai/claude-agent-sdk to make this real.');
}
