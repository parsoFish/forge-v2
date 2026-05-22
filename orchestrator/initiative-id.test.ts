/**
 * Unit tests for the dual-ID resolver (S1.1 — plan 07b).
 *
 * Covers contracts C6 (handle format = `<proj4>#<seq>`) and C17
 * (`_aliases.json` mints atomic via `proper-lockfile`).
 *
 * Each test stands up a fresh `_queue/_aliases.json` under a tempdir
 * so the live forge registry is never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveInitiativeId,
  mintHandle,
  loadAliases,
  mintName,
  registryPath,
  type AliasRegistry,
} from './initiative-id.ts';

function tmpQueue(): { queueRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'forge-init-ids-'));
  mkdirSync(join(root, '_queue'), { recursive: true });
  return {
    queueRoot: join(root, '_queue'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// mintHandle
// ---------------------------------------------------------------------------

test('mintHandle: derives 4-char prefix from project name and increments per-project counter', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const r1 = await mintHandle(
      'INIT-2026-05-19-trafficgame-backpressure-live',
      { queueRoot },
    );
    assert.equal(r1.handle, 'traf#1');
    assert.equal(r1.counter, 1);

    const r2 = await mintHandle(
      'INIT-2026-05-19-trafficgame-other-thing',
      { queueRoot },
    );
    assert.equal(r2.handle, 'traf#2');
    assert.equal(r2.counter, 2);

    const r3 = await mintHandle(
      'INIT-2026-05-18-betterado-release',
      { queueRoot },
    );
    assert.equal(r3.handle, 'bett#1');
    assert.equal(r3.counter, 1);
  } finally {
    cleanup();
  }
});

test('mintHandle: short project names (<4 chars) right-pad with 0', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const r = await mintHandle('INIT-2026-05-19-q-thing', { queueRoot });
    assert.equal(r.handle, 'q000#1');
  } finally {
    cleanup();
  }
});

test('mintHandle: project-prefix collision resolved by suffix-digit walk', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    // Seed registry so project "trafx" claims prefix "traf".
    const r1 = await mintHandle('INIT-2026-05-19-trafx-thing', { queueRoot });
    assert.equal(r1.handle, 'traf#1');

    // Different project with same raw prefix gets the suffix walk: tra2.
    const r2 = await mintHandle('INIT-2026-05-19-trafy-thing', { queueRoot });
    assert.equal(r2.handle, 'tra2#1');

    // Third clashing project: tra3.
    const r3 = await mintHandle('INIT-2026-05-19-trafz-thing', { queueRoot });
    assert.equal(r3.handle, 'tra3#1');
  } finally {
    cleanup();
  }
});

test('mintHandle: same canonical minted twice is idempotent (returns existing handle)', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const r1 = await mintHandle(
      'INIT-2026-05-19-trafficgame-x',
      { queueRoot },
    );
    const r2 = await mintHandle(
      'INIT-2026-05-19-trafficgame-x',
      { queueRoot },
    );
    assert.equal(r1.handle, r2.handle);
    assert.equal(r1.counter, r2.counter);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveInitiativeId
// ---------------------------------------------------------------------------

test('resolveInitiativeId: returns canonical input as-is once minted', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const canonical = 'INIT-2026-05-19-trafficgame-backpressure-live';
    await mintHandle(canonical, { queueRoot });
    const r = resolveInitiativeId(canonical, { queueRoot });
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') {
      assert.equal(r.canonical, canonical);
      assert.equal(r.handle, 'traf#1');
    }
  } finally {
    cleanup();
  }
});

test('resolveInitiativeId: resolves handle (proj#N) to canonical via by_handle map', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const canonical = 'INIT-2026-05-19-trafficgame-backpressure-live';
    await mintHandle(canonical, { queueRoot });
    const r = resolveInitiativeId('traf#1', { queueRoot });
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') {
      assert.equal(r.canonical, canonical);
      assert.equal(r.handle, 'traf#1');
    }
  } finally {
    cleanup();
  }
});

test('resolveInitiativeId: resolves named alias when globally unique', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const canonical = 'INIT-2026-05-19-trafficgame-backpressure-live';
    await mintHandle(canonical, { queueRoot });
    await mintName('traf#1', 'backpressure', { queueRoot });

    const r = resolveInitiativeId('backpressure', { queueRoot });
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') {
      assert.equal(r.canonical, canonical);
      assert.equal(r.name, 'backpressure');
    }
  } finally {
    cleanup();
  }
});

test('resolveInitiativeId: ambiguous canonical-substring match returns kind=ambiguous with all matches', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    // Two canonical IDs share a substring "backpressure".
    await mintHandle('INIT-2026-05-19-trafficgame-backpressure-live', { queueRoot });
    await mintHandle('INIT-2026-05-10-intersection-backpressure', { queueRoot });

    const r = resolveInitiativeId('backpressure', { queueRoot });
    assert.equal(r.kind, 'ambiguous');
    if (r.kind === 'ambiguous') {
      assert.equal(r.matches.length, 2);
      assert.ok(r.matches.includes('INIT-2026-05-19-trafficgame-backpressure-live'));
      assert.ok(r.matches.includes('INIT-2026-05-10-intersection-backpressure'));
    }
  } finally {
    cleanup();
  }
});

test('resolveInitiativeId: unknown input returns kind=not-found', () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const r = resolveInitiativeId('not-a-real-thing', { queueRoot });
    assert.equal(r.kind, 'not-found');
  } finally {
    cleanup();
  }
});

test('resolveInitiativeId: empty / missing registry treats as empty (canonical input still resolves to itself)', () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    // No mint, no registry on disk. A canonical-shaped input should still
    // resolve to itself (with handle = null) so the CLI can short-circuit
    // without minting on every read.
    const canonical = 'INIT-2026-05-19-trafficgame-backpressure-live';
    const r = resolveInitiativeId(canonical, { queueRoot });
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') {
      assert.equal(r.canonical, canonical);
      // handle may be empty string when unminted — caller decides whether
      // to mint at first use.
      assert.equal(r.handle, '');
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// loadAliases — parse-failure and empty-registry semantics (C16b)
// ---------------------------------------------------------------------------

test('loadAliases: returns empty registry when file does not exist', () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const reg = loadAliases({ queueRoot });
    assert.equal(reg.version, 1);
    assert.deepEqual(reg.by_handle, {});
    assert.deepEqual(reg.by_canonical, {});
    assert.deepEqual(reg.counters, {});
  } finally {
    cleanup();
  }
});

test('loadAliases: corrupt JSON treated as empty registry (idempotent replay over silent skip)', () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    writeFileSync(registryPath(queueRoot), '{ not valid json at all');
    const reg = loadAliases({ queueRoot });
    assert.equal(reg.version, 1);
    assert.deepEqual(reg.by_handle, {});
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Concurrency — proves proper-lockfile works as expected (AC6)
// ---------------------------------------------------------------------------

test('mintHandle: two concurrent mints produce distinct sequence numbers (proper-lockfile lock)', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    // Fire two mints in parallel for the same project. They should serialise
    // through proper-lockfile and produce counter values 1 and 2 — never 1 / 1.
    const [a, b] = await Promise.all([
      mintHandle('INIT-2026-05-19-trafficgame-aaa', { queueRoot }),
      mintHandle('INIT-2026-05-19-trafficgame-bbb', { queueRoot }),
    ]);
    const counters = [a.counter, b.counter].sort((x, y) => x - y);
    assert.deepEqual(counters, [1, 2], 'distinct sequence numbers');
    assert.notEqual(a.handle, b.handle);
  } finally {
    cleanup();
  }
});

test('mintHandle: ten concurrent mints all distinct (stress)', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const mints = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mintHandle(`INIT-2026-05-19-trafficgame-task${i}`, { queueRoot }),
      ),
    );
    const handles = new Set(mints.map((m) => m.handle));
    assert.equal(handles.size, 10, 'all 10 handles distinct');
    const counters = mints.map((m) => m.counter).sort((x, y) => x - y);
    assert.deepEqual(counters, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Registry shape — schema sanity
// ---------------------------------------------------------------------------

test('mintHandle: persists registry shape matching the locked schema', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    const canonical = 'INIT-2026-05-19-trafficgame-x';
    await mintHandle(canonical, { queueRoot });
    const raw = readFileSync(registryPath(queueRoot), 'utf8');
    const parsed = JSON.parse(raw) as AliasRegistry;
    assert.equal(parsed.version, 1);
    assert.equal(parsed.by_handle['traf#1'], canonical);
    assert.equal(parsed.by_canonical[canonical].handle, 'traf#1');
    assert.equal(parsed.counters.traf, 1);
  } finally {
    cleanup();
  }
});

test('mintName: rejects collisions (cannot reuse a name pointing at a different canonical)', async () => {
  const { queueRoot, cleanup } = tmpQueue();
  try {
    await mintHandle('INIT-2026-05-19-trafficgame-aaa', { queueRoot });
    await mintHandle('INIT-2026-05-19-trafficgame-bbb', { queueRoot });
    await mintName('traf#1', 'fooname', { queueRoot });

    await assert.rejects(
      () => mintName('traf#2', 'fooname', { queueRoot }),
      /already taken|collision|conflict/i,
    );
  } finally {
    cleanup();
  }
});
