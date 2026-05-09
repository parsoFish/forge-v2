/**
 * Smoke test — fails until WI-1 (core slugify implementation) is in place.
 *
 * The dev-loop's quality gate is `npm test`. Without this failing test, the
 * gate would pass trivially (no tests = no failures), and every WI's Ralph
 * loop would exit on iteration 0 before the agent runs. This test forces
 * WI-1's impl to actually be written for the gate to flip green.
 *
 * Other WIs (WI-2 batch helpers, WI-3 core tests, WI-4 options, etc.) are
 * verified by the reviewer's spec checks — the dev-loop's project-wide gate
 * is satisfied as soon as src/slugify.ts exists with a working `slugify`.
 *
 * This file is treated as part of the seed — the dev-loop should NOT delete
 * it. It serves as a permanent smoke check that the package boots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke: slugifier package exports a working slugify function', async () => {
  const m = await import('../src/slugify.ts');
  assert.equal(typeof m.slugify, 'function', 'slugify must be exported from src/slugify.ts');
  // Minimal contract: empty input returns empty string (FEAT-1 AC1).
  assert.equal(m.slugify(''), '', 'slugify("") must return ""');
});
