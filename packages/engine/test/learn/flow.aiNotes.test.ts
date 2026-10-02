// learn-v7 (issue #40, SPEC 8.10, 15): the notes an AI answer may put on an unsupported column - a plain-language explanation (a guess) and a
// function request - leave the rules in the engine's flow: `rules` / `unsupported` never carry them, they travel beside the answer as
// `aiNotes`, the explanation unmasked with the session's masker (real words), and the completion payload never sends them back.
import type { LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { completePayloadOf } from '../../src/learn/complete';
import { externalOnlyPair, type Pair, xlsxBytesOf } from './v5fixtures';

async function bytes(pair: Pair) {
  return { input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' }, output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' } };
}

async function localRules(pair: Pair): Promise<LearnResult> {
  const r = await learnFromExamples({ ...(await bytes(pair)), masking: false, tier: 'paid', ai: 'notAllowed', callLearn: async () => { throw new Error('no AI step here'); } });
  if (r.path !== 'partial' || !r.rules) throw new Error(`expected a partial result, got ${r.path}`);
  return r.rules;
}

const request = { name: 'lookupWarehouse', purpose: 'Finds the storage site for an item from a table kept elsewhere.', args: [{ name: 'item', type: 'text' as const }], returns: 'text' as const };

describe('learnFromExamples: the notes on an unsupported column (learn-v7)', () => {
  it.each([false, true])('takes explanation and functionRequest OUT of the rules and puts them beside the answer (masking %s)', async (masking) => {
    const pair = externalOnlyPair();
    const local = await localRules(pair);
    const payloads: LearnPayload[] = [];
    const res = await learnFromExamples({
      ...(await bytes(pair)),
      masking,
      ...(masking ? { key: new TextEncoder().encode('notes-test') } : {}),
      tier: 'paid',
      callLearn: async (payload): Promise<LearnCallResult> => {
        payloads.push(payload);
        const rules: LearnResult = {
          ...local,
          unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData', explanation: 'Looks like the storage site of the item.', functionRequest: request }],
        };
        return { rules, problems: [], calls: [] };
      },
    });

    expect(res.path).toBe('llm');
    expect(res.verification?.verified).toBe(true);
    // Never in the rules: not in `rules`, not in `unsupported`.
    expect(res.rules?.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
    expect(res.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
    expect(JSON.stringify(res.rules)).not.toContain('storage site');
    expect(JSON.stringify(res.rules)).not.toContain('lookupWarehouse');
    // Beside them.
    expect(res.aiNotes).toEqual([{ header: 'Warehouse', explanation: 'Looks like the storage site of the item.', functionRecorded: true }]);
  });

  it('unmasks the explanation with the session masker: the browser sees real words, the API only ever saw the fakes', async () => {
    const pair = externalOnlyPair();
    const local = await localRules(pair);
    // The REAL warehouse word of the first data row (output column 3).
    const realWord = String(pair.output[1]![3]);
    let fake = '';
    const res = await learnFromExamples({
      ...(await bytes(pair)),
      masking: true,
      key: new TextEncoder().encode('notes-test-2'),
      tier: 'paid',
      callLearn: async (payload): Promise<LearnCallResult> => {
        const sample = payload.samples[0]!;
        fake = String((sample.out as (string | number)[])[3]);
        expect(fake).not.toBe(realWord); // masked on the wire
        const rules: LearnResult = { ...local, unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData', explanation: `Every row says ${fake} here.` }] };
        return { rules, problems: [], calls: [] };
      },
    });
    expect(res.aiNotes).toEqual([{ header: 'Warehouse', explanation: `Every row says ${realWord} here.` }]);
    expect(JSON.stringify(res.aiNotes)).not.toContain(fake);
    expect(JSON.stringify(res.rules)).not.toContain(realWord + ' here');
  });

  it('an answer with no notes has no aiNotes', async () => {
    const pair = externalOnlyPair();
    const local = await localRules(pair);
    const res = await learnFromExamples({
      ...(await bytes(pair)),
      masking: false,
      tier: 'paid',
      callLearn: async () => ({ rules: { ...local, unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData' }] }, problems: [], calls: [] }),
    });
    expect(res.path).toBe('llm');
    expect(res.aiNotes).toBeUndefined();
  });

  it('the completion payload never sends the notes back to the AI step (the fixed rules are stripped)', async () => {
    const local = await localRules(externalOnlyPair());
    const withNotes: LearnResult = { ...local, unsupported: [{ outputColumn: 'Warehouse', reasonCode: 'externalData', explanation: 'a guess with a name in it', functionRequest: request }] };
    const complete = completePayloadOf({ fixedRules: withNotes, columns: [], parts: [] }, undefined);
    expect(JSON.stringify(complete)).not.toContain('a guess with a name in it');
    expect(JSON.stringify(complete)).not.toContain('lookupWarehouse');
    expect(JSON.stringify(complete.fixed)).toContain('externalData');
  });
});
