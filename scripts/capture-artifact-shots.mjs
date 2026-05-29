/**
 * capture-artifact-shots — render a self-contained artifact HTML (PLAN.html /
 * DEMO.html / comparison.html) to a PNG for durable archival (ADR 020 / Phase E).
 *
 *   node scripts/capture-artifact-shots.mjs <input.html> <output.png>
 *   node scripts/capture-artifact-shots.mjs --pair <in.html>:<out.png> [--pair ...]
 *
 * BEST-EFFORT BY DESIGN: this is off the critical path. Every failure (missing
 * chromium, unreadable HTML, render error) is caught + logged and the process
 * STILL exits 0 — a screenshot must never fail a cycle or a plan approval.
 *
 * Reusable as a module too: `import { captureArtifactShot } from './capture-artifact-shots.mjs'`.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Render one HTML file to a PNG. Returns true on success, false (logged) on any
 * failure — never throws.
 */
export async function captureArtifactShot(inputHtml, outputPng) {
  try {
    if (!existsSync(inputHtml)) {
      console.error(`[capture] skip — input not found: ${inputHtml}`);
      return false;
    }
    // Lazy import so a missing chromium degrades gracefully instead of crashing
    // the caller at import time.
    const { chromium } = await import('playwright-core');
    mkdirSync(dirname(resolve(outputPng)), { recursive: true });
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1200, height: 1400 } })).newPage();
      await page.goto(pathToFileURL(resolve(inputHtml)).href, { waitUntil: 'networkidle', timeout: 15000 });
      await page.screenshot({ path: resolve(outputPng), fullPage: true });
      console.error(`[capture] ${inputHtml} → ${outputPng}`);
      return true;
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(`[capture] best-effort failure for ${inputHtml}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--pair') {
      const spec = args[++i] ?? '';
      const idx = spec.lastIndexOf(':');
      if (idx > 0) pairs.push([spec.slice(0, idx), spec.slice(idx + 1)]);
    }
  }
  if (pairs.length === 0 && args.length >= 2) pairs.push([args[0], args[1]]);

  if (pairs.length === 0) {
    console.error('usage: capture-artifact-shots.mjs <input.html> <output.png> | --pair <in>:<out> [--pair ...]');
    process.exit(0); // best-effort — never a hard failure
  }

  for (const [inp, out] of pairs) {
    await captureArtifactShot(inp, out);
  }
  process.exit(0);
}

// Only run as a CLI (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
