/**
 * `forge watch` — foreground subcommand that brings up the operator UI.
 *
 * Spawns two children:
 *   1. The forge-ui bridge (cli/ui-bridge.ts) — WebSocket + HTTP API.
 *   2. The forge-ui Next.js dev server (forge-ui workspace) — the browser.
 *
 * Opens the operator's default browser at the Next.js URL once the dev
 * server reports ready. On SIGINT (Ctrl-C) it tears both children down
 * and exits 0.
 *
 * Stage M2-A scope: read-only viewing. Verdict POST handlers come in M2-C.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';

import { startBridge } from './ui-bridge.ts';

export type WatchOptions = {
  forgeRoot: string;
  /** Override the bridge's HTTP port. 0 = OS-assigned (default). */
  bridgePort?: number;
  /** Override the Next.js dev port. Default 3000 (Next.js default). */
  uiPort?: number;
  /** Skip the browser open (useful for headless CI). */
  noOpen?: boolean;
  /** Skip launching the UI dev server (bridge only). Lets the operator
   *  point a pre-built static export at the bridge by hand. */
  bridgeOnly?: boolean;
};

export async function runWatch(opts: WatchOptions): Promise<void> {
  const { forgeRoot } = opts;
  const uiDir = resolve(forgeRoot, 'forge-ui');

  // 1. Start the bridge.
  const bridge = startBridge({ forgeRoot, port: opts.bridgePort ?? 0 });
  console.log(`[forge watch] bridge at ${bridge.url}`);

  // 2. Start Next.js dev (unless --bridge-only or forge-ui not installed).
  let uiProc: ChildProcess | null = null;
  let uiPort = 0;
  if (!opts.bridgeOnly) {
    if (!existsSync(resolve(uiDir, 'package.json'))) {
      console.log('[forge watch] forge-ui workspace not present yet (forge-ui/package.json missing).');
      console.log('[forge watch] running bridge-only — install the workspace then re-run.');
    } else {
      // Probe for a free port starting at the explicit / default 3000, so an
      // existing dev server on 3000 doesn't EADDRINUSE the spawn. Next.js
      // itself doesn't search — `next dev -p <n>` just fails if <n> is taken.
      uiPort = await findFreePort(opts.uiPort ?? 3000);
      if (uiPort === 0) {
        console.error('[forge watch] no free port found near the requested ui port — pass --ui-port <n>.');
        await bridge.close();
        process.exit(1);
      }
      if (opts.uiPort !== undefined && uiPort !== opts.uiPort) {
        console.warn(`[forge watch] requested ui-port ${opts.uiPort} is in use; falling back to ${uiPort}.`);
      }
      console.log(`[forge watch] ui at http://localhost:${uiPort} (starting next dev…)`);

      uiProc = spawn(
        'npm',
        ['run', 'dev', '--workspace', 'forge-ui', '--', '-p', String(uiPort)],
        {
          cwd: forgeRoot,
          env: {
            ...process.env,
            FORGE_BRIDGE_URL: bridge.url,
          },
          stdio: 'inherit',
        },
      );
      uiProc.on('error', (err) => {
        console.error(`[forge watch] forge-ui dev server failed to start: ${err.message}`);
      });
    }
  }

  // 3. Wait briefly, then open the browser.
  if (uiProc && !opts.noOpen) {
    setTimeout(() => {
      const url = `http://localhost:${uiPort}`;
      openBrowser(url).catch((err) => {
        console.error(`[forge watch] could not open browser: ${err.message}`);
        console.log(`[forge watch] open ${url} manually.`);
      });
    }, 2000); // give Next.js a couple of seconds to bind the port
  }

  // 4. Clean up on Ctrl-C.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[forge watch] shutting down...');
    if (uiProc && !uiProc.killed) {
      try { uiProc.kill('SIGTERM'); } catch { /* already dead */ }
    }
    try { await bridge.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  // 5. Block forever (children own the foreground).
  await new Promise<void>(() => {
    // intentionally never resolves; SIGINT path handles exit.
  });
}

/**
 * Find a free TCP port starting at `start`, walking up by 1 for up to
 * `range` attempts. Returns 0 if none free (caller should treat as
 * fatal). Uses node:net to bind+close — same mechanism Next.js / Vite
 * use internally; avoids any race-free guarantee but is good enough for
 * a foreground operator command.
 */
export async function findFreePort(start: number, range = 50): Promise<number> {
  for (let p = start; p < start + range; p += 1) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createNetServer();
    let settled = false;
    const done = (free: boolean): void => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch { /* ignore */ }
      res(free);
    };
    srv.once('error', () => done(false));
    srv.once('listening', () => done(true));
    try { srv.listen(port, '127.0.0.1'); } catch { done(false); }
  });
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open'; args = [url];
  }
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', detached: true });
    proc.on('error', rejectOpen);
    proc.on('spawn', () => {
      proc.unref();
      resolveOpen();
    });
  });
}
