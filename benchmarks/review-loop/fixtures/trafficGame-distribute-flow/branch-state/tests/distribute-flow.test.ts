import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distributeFlow } from '../src/flow.ts';

test('distributeFlow: single lane gets the full total', () => {
  assert.deepEqual(distributeFlow(100, 1), [100]);
});

test('distributeFlow: bias towards main lane (50/50 split with one other)', () => {
  assert.deepEqual(distributeFlow(100, 2), [50, 50]);
});

test('distributeFlow: 50% to main, rest evenly split across the others', () => {
  const out = distributeFlow(100, 3);
  assert.equal(out[0], 50);
  assert.equal(out[1], 25);
  assert.equal(out[2], 25);
});

test('distributeFlow: zero flow distributes zero everywhere', () => {
  assert.deepEqual(distributeFlow(0, 4), [0, 0, 0, 0]);
});

test('distributeFlow: negative total throws', () => {
  assert.throws(() => distributeFlow(-1, 2), /total flow/);
});

test('distributeFlow: zero lanes throws', () => {
  assert.throws(() => distributeFlow(100, 0), /lanes must be >= 1/);
});
