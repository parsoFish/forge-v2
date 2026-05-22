/**
 * Tests for the LLM Council critic-chain runner.
 *
 * Each critic is invoked as an SDK subagent. Tests inject a fake queryFn that
 * yields a `result` message whose `structured_output` is the critic's verdict.
 * We verify:
 *   - Critics are invoked in declared order.
 *   - flags (mechanical) are auto-applied to the draft.
 *   - escalations (taste) are aggregated and de-duplicated.
 *   - The chain stops if a critic times out / errors and surfaces the error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runCouncil,
  defaultCritics,
  type Critic,
  type CriticVerdict,
  type CouncilQueryFn,
  type CouncilEvent,
} from './council.ts';

type CapturedInvocation = { criticName: string; prompt: string };

function fakeQueryFn(
  verdictsByCritic: Record<string, CriticVerdict>,
  captured: CapturedInvocation[],
): CouncilQueryFn {
  return ({ prompt, options }) => {
    const criticName = String((options as Record<string, unknown>)?.['_criticName'] ?? '<unknown>');
    captured.push({ criticName, prompt });
    const verdict = verdictsByCritic[criticName] ?? { flags: [], escalations: [] };
    async function* gen() {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        num_turns: 1,
        structured_output: verdict,
      };
    }
    return gen();
  };
}

const DRAFT = '# Draft initiative\n\nAdd login + profile.';

test('runCouncil: invokes critics in declared order', async () => {
  const captured: CapturedInvocation[] = [];
  const critics: Critic[] = [
    { name: 'ceo', prompt: 'You are the CEO critic.', model: 'sonnet' },
    { name: 'eng', prompt: 'You are the engineering critic.', model: 'sonnet' },
    { name: 'design', prompt: 'You are the design critic.', model: 'sonnet' },
    { name: 'dx', prompt: 'You are the DX critic.', model: 'sonnet' },
  ];

  await runCouncil({
    draft: DRAFT,
    critics,
    queryFn: fakeQueryFn({}, captured),
  });

  assert.deepEqual(
    captured.map((c) => c.criticName),
    ['ceo', 'eng', 'design', 'dx'],
  );
  for (const c of captured) assert.match(c.prompt, /Add login/);
});

test('runCouncil: auto-applies flags and aggregates escalations', async () => {
  const captured: CapturedInvocation[] = [];
  const critics: Critic[] = [
    { name: 'ceo', prompt: 'CEO', model: 'sonnet' },
    { name: 'eng', prompt: 'Eng', model: 'sonnet' },
  ];
  const verdicts: Record<string, CriticVerdict> = {
    ceo: {
      flags: [{ id: 'missing-rollback', description: 'No rollback note', appliedFix: 'Added rollback section to body.' }],
      escalations: [
        {
          critic: 'ceo',
          question: 'One initiative or two?',
          options: [
            { label: 'one', rationale: 'simpler review' },
            { label: 'two', rationale: 'parallel work' },
          ],
        },
      ],
    },
    eng: {
      flags: [{ id: 'undeclared-dep', description: 'FEAT-2 missing depends_on', appliedFix: 'Added depends_on: [FEAT-1] to FEAT-2.' }],
      escalations: [
        // Duplicate escalation — should de-dupe by (critic, question).
        {
          critic: 'ceo',
          question: 'One initiative or two?',
          options: [{ label: 'one', rationale: 'duplicate' }],
        },
        {
          critic: 'eng',
          question: 'Use server-side or client-side validation?',
          options: [
            { label: 'server', rationale: 'authoritative' },
            { label: 'client', rationale: 'snappier UX' },
          ],
        },
      ],
    },
  };

  const result = await runCouncil({
    draft: DRAFT,
    critics,
    queryFn: fakeQueryFn(verdicts, captured),
  });

  assert.equal(result.flags.length, 2, 'two flags collected');
  assert.equal(result.escalations.length, 2, 'duplicate escalation de-duped');
  assert.deepEqual(
    result.escalations.map((e) => `${e.critic}:${e.question}`),
    ['ceo:One initiative or two?', 'eng:Use server-side or client-side validation?'],
  );
  assert.ok(result.totalCostUsd > 0, 'cost accumulated across critics');
  assert.equal(result.totalCostUsd, 0.02, 'cost = sum of per-critic cost');
});

test('runCouncil: no result message ⇒ runner falls through to fallback (does NOT throw, post-I-23)', async () => {
  // Pre-S2A this case threw with /ceo.*no result/. Post-S2A the runner
  // retries with a tighter prompt asking for fenced JSON; both attempts here
  // also yield no result message, so the runner records a fallback-required
  // event and returns a partial result.
  const critics: Critic[] = [{ name: 'ceo', prompt: 'CEO', model: 'sonnet' }];
  const queryFn: CouncilQueryFn = () => {
    async function* gen() {
      // No `result` event — simulates a timeout / abort.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
    }
    return gen();
  };
  const events: CouncilEvent[] = [];
  const result = await runCouncil({
    draft: DRAFT,
    critics,
    queryFn,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.fallbackCritics.length, 1);
  assert.equal(result.fallbackCritics[0], 'ceo');
  assert.ok(events.some((e) => e.type === 'council.fallback-required'));
});

// Note: prior to the S2A robustness fix (I-23), missing structured_output
// threw. As of S2A, the runner retries with a tighter messageFormat asking
// for fenced JSON; if BOTH attempts fail it emits a fallback-required event
// and returns a partial result. The retry path is covered below.

test('defaultCritics: returns ceo + eng + design + dx in order', () => {
  const critics = defaultCritics();
  assert.deepEqual(
    critics.map((c) => c.name),
    ['ceo', 'eng', 'design', 'dx'],
  );
  // Each has a non-trivial prompt
  for (const c of critics) {
    assert.ok(c.prompt.length > 50, `${c.name} prompt is non-trivial`);
  }
});

// ---------------------------------------------------------------------------
// Robustness fix (I-23) — added in stage S2A of the 2026-05-20 refinement.
// ---------------------------------------------------------------------------

test('runCouncil: empty structured_output ⇒ retries once with tighter messageFormat, parses fenced JSON, returns verdict', async () => {
  const critics: Critic[] = [{ name: 'eng', prompt: 'Eng', model: 'sonnet' }];
  let call = 0;
  const queryFn: CouncilQueryFn = () => {
    call += 1;
    async function* gen() {
      if (call === 1) {
        // First attempt: no structured_output (the I-23 failure mode).
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1 };
        return;
      }
      // Second attempt (after retry): the critic repeats its verdict as a fenced JSON block.
      yield {
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: [
              'Here is the verdict as requested:',
              '',
              '```json',
              JSON.stringify({
                flags: [{ id: 'retry-ok', description: 'fix', appliedFix: 'applied' }],
                escalations: [],
              }),
              '```',
            ].join('\n'),
          }],
        },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1 };
    }
    return gen();
  };

  const result = await runCouncil({ draft: DRAFT, critics, queryFn });
  assert.equal(call, 2, 'retry fired exactly once');
  assert.equal(result.flags.length, 1, 'retry verdict was parsed from fenced JSON');
  assert.equal(result.flags[0].id, 'retry-ok');
  assert.ok(result.totalCostUsd > 0);
});

test('runCouncil: empty structured_output on both attempts ⇒ partial result + fallback event emitted', async () => {
  const critics: Critic[] = [{ name: 'ceo', prompt: 'CEO', model: 'sonnet' }];
  const events: Array<{ type: string; critic?: string; rawText?: string }> = [];
  const queryFn: CouncilQueryFn = () => {
    async function* gen() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no JSON here' }] },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0.005, num_turns: 1 };
    }
    return gen();
  };

  const result = await runCouncil({
    draft: DRAFT,
    critics,
    queryFn,
    onEvent: (e) => events.push(e),
  });

  // Did NOT throw; partial result returned
  assert.ok(result, 'runCouncil returned a result instead of throwing');
  assert.equal(result.perCritic.length, 1);
  // The critic verdict surfaces the raw text the architect can read
  const ev = events.find((e) => e.type === 'council.fallback-required');
  assert.ok(ev, 'council.fallback-required event was emitted');
  assert.equal(ev?.critic, 'ceo');
  assert.match(ev?.rawText ?? '', /no JSON here/);
});

test('runCouncil: respects maxDraftChars by truncating long drafts before invoking the critic', async () => {
  const critics: Critic[] = [{ name: 'eng', prompt: 'Eng', model: 'sonnet' }];
  const longDraft = '# huge draft\n' + 'x'.repeat(25_000);
  let observedPromptLen = 0;
  const queryFn: CouncilQueryFn = ({ prompt }) => {
    observedPromptLen = prompt.length;
    async function* gen() {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        num_turns: 1,
        structured_output: { flags: [], escalations: [] },
      };
    }
    return gen();
  };

  await runCouncil({ draft: longDraft, critics, queryFn, maxDraftChars: 5_000 });
  // The prompt is the critic prompt + the (truncated) draft + boilerplate;
  // the upper bound is maxDraftChars + a generous slack for the prompt
  // framing. The original draft was 25k chars; if we hadn't truncated, the
  // prompt would necessarily be ≥ 25k.
  assert.ok(
    observedPromptLen < 10_000,
    `prompt length ${observedPromptLen} suggests draft was NOT truncated to 5_000 chars`,
  );
});

test('runCouncil: a synthetic 20k-char draft does not throw (default maxDraftChars 50_000 accommodates it)', async () => {
  const critics: Critic[] = [{ name: 'ceo', prompt: 'CEO', model: 'sonnet' }];
  const draft = '# huge\n' + 'y'.repeat(20_000);
  const queryFn: CouncilQueryFn = () => {
    async function* gen() {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.01,
        num_turns: 1,
        structured_output: { flags: [], escalations: [] },
      };
    }
    return gen();
  };
  // Should NOT throw — proves AC8 (handles ≥ 20k draft).
  const result = await runCouncil({ draft, critics, queryFn });
  assert.ok(result);
  assert.equal(result.perCritic.length, 1);
});
