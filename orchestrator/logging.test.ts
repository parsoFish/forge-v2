/**
 * Smoke tests for the JSONL event logger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logging.ts';

test('logger: round-trips cache_read_tokens + cache_creation_tokens through JSONL (S8 / C23)', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-log-cache-'));
  try {
    const logger = createLogger('cycle-cache', join(root, '_logs'));
    logger.emit({
      initiative_id: 'INIT-cache',
      phase: 'developer-loop',
      skill: 'dev-ralph',
      event_type: 'iteration',
      iteration: 2,
      input_refs: [],
      output_refs: [],
      cost_usd: 0.04,
      tokens_in: 1_200,
      tokens_out: 180,
      cache_read_tokens: 9_500,
      cache_creation_tokens: 250,
    });
    const lines = readFileSync(logger.logFilePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.cache_read_tokens, 9_500);
    assert.equal(entry.cache_creation_tokens, 250);
    assert.equal(entry.tokens_in, 1_200);
    assert.equal(entry.tokens_out, 180);
    assert.equal(entry.cost_usd, 0.04);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logger: cache token fields are optional — entries without them round-trip cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-log-nocache-'));
  try {
    const logger = createLogger('cycle-nocache', join(root, '_logs'));
    logger.emit({
      initiative_id: 'INIT-nocache',
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'start',
      input_refs: [],
      output_refs: [],
    });
    const lines = readFileSync(logger.logFilePath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.cache_read_tokens, undefined);
    assert.equal(entry.cache_creation_tokens, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logger: writes JSONL events to _logs/<cycle-id>/events.jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-log-'));
  try {
    const logger = createLogger('cycle-smoke', join(root, '_logs'));
    logger.emit({
      initiative_id: 'INIT-smoke',
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'start',
      input_refs: ['fixture.md'],
      output_refs: [],
    });
    logger.emit({
      initiative_id: 'INIT-smoke',
      phase: 'orchestrator',
      skill: 'cycle',
      event_type: 'end',
      input_refs: ['fixture.md'],
      output_refs: [],
      duration_ms: 42,
    });

    const lines = readFileSync(logger.logFilePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const start = JSON.parse(lines[0]);
    const end = JSON.parse(lines[1]);
    assert.equal(start.event_type, 'start');
    assert.equal(end.event_type, 'end');
    assert.equal(start.cycle_id, 'cycle-smoke');
    assert.equal(end.duration_ms, 42);
    assert.match(start.event_id, /^EV_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
