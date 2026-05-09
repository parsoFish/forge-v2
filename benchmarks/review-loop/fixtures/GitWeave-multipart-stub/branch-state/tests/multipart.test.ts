import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOnBoundary } from '../src/multipart.ts';

test('splitOnBoundary splits body on a boundary marker', () => {
  const body = '--BOUND\nfirst\n--BOUND\nsecond\n--BOUND--';
  const parts = splitOnBoundary(body, 'BOUND');
  assert.deepEqual(parts, ['first', 'second']);
});

test('splitOnBoundary returns empty array when no boundary appears', () => {
  assert.deepEqual(splitOnBoundary('not multipart', 'BOUND'), []);
});

test('splitOnBoundary preserves internal whitespace on each part', () => {
  const body = '--X\n  hello \n--X\nworld\n--X--';
  const parts = splitOnBoundary(body, 'X');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], '  hello ');
  assert.equal(parts[1], 'world');
});

test('splitOnBoundary ignores trailing closing marker (--BOUND--)', () => {
  const body = '--Z\nonly\n--Z--';
  const parts = splitOnBoundary(body, 'Z');
  assert.deepEqual(parts, ['only']);
});
