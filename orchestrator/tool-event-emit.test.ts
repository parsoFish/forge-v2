/**
 * Phase A — sampler + sink unit tests. Drives synthetic high-volume tool-use
 * sequences (the "mock data") through the sampler and the logger-bound sink,
 * asserting the volume ceiling, read-only sampling, file-modifying/Bash
 * never-drop guarantee, and that everything dropped is surfaced (no silent cap).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EventLogEntry, EventLogger } from './logging.ts';
import type { ToolUseLiveDetail } from '../loops/ralph/claude-agent.ts';
import { createToolEventSampler, makeToolEventSink } from './tool-event-emit.ts';

/** In-memory logger that captures emitted entries instead of writing to disk. */
function captureLogger(): { logger: EventLogger; entries: EventLogEntry[] } {
  const entries: EventLogEntry[] = [];
  const logger: EventLogger = {
    cycleId: 'TEST',
    logFilePath: '/dev/null',
    emit: (partial) => {
      const entry = { event_id: 'EV_TEST', cycle_id: 'TEST', started_at: 'T', ...partial } as EventLogEntry;
      entries.push(entry);
      return entry;
    },
  };
  return { logger, entries };
}

const det = (name: string, seq: number, filePath?: string, op?: ToolUseLiveDetail['op']): ToolUseLiveDetail => ({
  name,
  inputSummary: filePath ?? name,
  filePath,
  op,
  seq,
});

test('sampler: read-only tools sampled 1-in-N, drops surfaced', () => {
  const sampler = createToolEventSampler({ cap: 50, readOnlySampleRate: 4 });
  let emitted = 0;
  for (let seq = 1; seq <= 8; seq++) {
    if (sampler.consider(det('Read', seq)).emit) emitted += 1;
  }
  // Of 8 reads: emit on the 1st and 5th read → 2 emitted, 6 sampled out.
  assert.equal(emitted, 2);
  const { coalescedCount, sampledOutCount } = sampler.flush();
  assert.equal(coalescedCount, 0);
  assert.equal(sampledOutCount, 6);
});

test('sampler: file-modifying + Bash always emit (never sampled)', () => {
  const sampler = createToolEventSampler({ cap: 50, readOnlySampleRate: 4 });
  const always = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
  let emitted = 0;
  always.forEach((name, i) => {
    if (sampler.consider(det(name, i + 1)).emit) emitted += 1;
  });
  assert.equal(emitted, always.length);
});

test('sampler: caps individual emits then coalesces the remainder', () => {
  const sampler = createToolEventSampler({ cap: 50, readOnlySampleRate: 4 });
  let emitted = 0;
  for (let seq = 1; seq <= 60; seq++) {
    if (sampler.consider(det('Bash', seq)).emit) emitted += 1;
  }
  assert.equal(emitted, 50); // hard ceiling
  const { coalescedCount } = sampler.flush();
  assert.equal(coalescedCount, 10); // 60 - 50, accounted for (not silent)
});

test('sampler: seq===1 resets per-iteration budget', () => {
  const sampler = createToolEventSampler({ cap: 2, readOnlySampleRate: 1 });
  assert.equal(sampler.consider(det('Bash', 1)).emit, true);
  assert.equal(sampler.consider(det('Bash', 2)).emit, true);
  assert.equal(sampler.consider(det('Bash', 3)).emit, false); // over cap
  // New iteration (seq 1) → budget resets without an explicit flush.
  assert.equal(sampler.consider(det('Bash', 1)).emit, true);
});

test('sink: emits tool_use + file_change for a file op, with metadata', () => {
  const { logger, entries } = captureLogger();
  const sink = makeToolEventSink(logger, {
    initiativeId: 'INIT-1',
    parentEventId: 'EV_PARENT',
    phase: 'developer-loop',
    skill: 'developer-ralph',
    workItemId: 'WI-2',
    featureId: 'FEAT-1',
  });
  sink.onToolUse(det('Edit', 1, 'src/foo.ts', 'modify'));

  const toolUse = entries.find((e) => e.event_type === 'tool_use');
  const fileChange = entries.find((e) => e.event_type === 'file_change');
  assert.ok(toolUse, 'tool_use emitted');
  assert.ok(fileChange, 'file_change emitted');
  assert.equal(toolUse!.metadata?.tool, 'Edit');
  assert.equal(toolUse!.metadata?.work_item_id, 'WI-2');
  assert.equal(toolUse!.metadata?.feature_id, 'FEAT-1');
  assert.equal(fileChange!.metadata?.path, 'src/foo.ts');
  assert.equal(fileChange!.metadata?.op, 'modify');
  assert.deepEqual(fileChange!.output_refs, ['src/foo.ts']);
});

test('sink: high-volume burst stays bounded and drops nothing silently', () => {
  const { logger, entries } = captureLogger();
  const sink = makeToolEventSink(logger, {
    initiativeId: 'INIT-1',
    parentEventId: 'EV_PARENT',
    phase: 'developer-loop',
    skill: 'developer-ralph',
    workItemId: 'WI-1',
  });

  // 200 tool calls: 170 reads + 30 edits interleaved (the "high-volume" mock).
  let seq = 0;
  let edits = 0;
  for (let i = 0; i < 200; i++) {
    seq += 1;
    if (i % 7 === 0) {
      edits += 1;
      sink.onToolUse(det('Edit', seq, `src/file${i}.ts`, 'modify'));
    } else {
      sink.onToolUse(det('Read', seq, `src/file${i}.ts`));
    }
  }
  sink.flushIteration(1);

  const toolUseEvents = entries.filter((e) => e.event_type === 'tool_use' && e.metadata?.coalesced !== true);
  const fileChanges = entries.filter((e) => e.event_type === 'file_change');
  const coalesced = entries.find((e) => e.metadata?.coalesced === true);

  // Bounded: individual tool_use emits never exceed the cap (50).
  assert.ok(toolUseEvents.length <= 50, `tool_use emits bounded: ${toolUseEvents.length}`);
  // Every Edit produced a durable file_change (never sampled/coalesced away).
  assert.equal(fileChanges.length, edits);
  // The drop is surfaced, not silent.
  assert.ok(coalesced, 'coalesced summary emitted');
  const dropped = (coalesced!.metadata?.coalesced_count as number) + (coalesced!.metadata?.sampled_out_count as number);
  assert.ok(dropped > 0, 'coalesced summary accounts for dropped calls');
});
