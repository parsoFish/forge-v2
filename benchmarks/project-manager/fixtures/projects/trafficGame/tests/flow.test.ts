import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictLoads } from '../src/flow.ts';

test('predictLoads returns one entry per intersection', () => {
  const out = predictLoads(
    [
      { id: 'I1', edgesOut: [] },
      { id: 'I2', edgesOut: [] },
    ],
    0,
  );
  assert.equal(out.length, 2);
});
