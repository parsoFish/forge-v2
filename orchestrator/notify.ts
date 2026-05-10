/**
 * Pluggable notifications (per ADR 013). Default provider: desktop. Optional:
 * webhook. Adding a provider = drop a function in this file and dispatch on
 * config.
 */

import { execSync } from 'node:child_process';

export type NotifyEvent = {
  type: 'review-ready' | 'merged' | 'failed' | 'recovered';
  title: string;
  body: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type NotifyConfig = {
  desktop: boolean;
  webhook_url: string | null;
};

export async function notify(event: NotifyEvent, config: NotifyConfig): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  if (config.desktop) tasks.push(desktopNotify(event));
  if (config.webhook_url) tasks.push(webhookNotify(event, config.webhook_url));
  await Promise.allSettled(tasks);
}

async function desktopNotify(event: NotifyEvent): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'linux') {
      execSync(
        `notify-send ${shellQuote(`forge: ${event.title}`)} ${shellQuote(event.body)}`,
        { stdio: 'pipe' },
      );
    } else if (platform === 'darwin') {
      execSync(
        `osascript -e 'display notification ${shellQuote(event.body)} with title ${shellQuote(`forge: ${event.title}`)}'`,
        { stdio: 'pipe' },
      );
    } else if (platform === 'win32') {
      // Minimal PowerShell toast — best-effort.
      const ps = `New-BurntToastNotification -Text 'forge: ${event.title}', '${event.body.replace(/'/g, "''")}'`;
      execSync(`powershell.exe -Command "${ps}"`, { stdio: 'pipe' });
    }
  } catch {
    // Best-effort; if the user has no notifier installed, we don't crash.
  }
}

async function webhookNotify(event: NotifyEvent, url: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: event.type,
        title: event.title,
        body: event.body,
        url: event.url,
        metadata: event.metadata,
        ts: new Date().toISOString(),
      }),
    });
  } catch {
    // Best-effort; log surfaces failures via the orchestrator's event log.
  }
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
