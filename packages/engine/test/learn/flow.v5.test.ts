// learnFromExamples, SPEC 21 v5 items 1 and 4: signed-out callers never reach the LLM and get the local
// partial result; the AI readiness gate runs right before the payload/LLM call; "only external columns left"
// finishes locally with no LLM call. `callLearn` is a spy: these tests are mostly about when it is NOT called.
import type { Format, LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult, type LearnFromExamplesOptions } from '../../src/learn/flow';
import { formatOf } from '../../src/registry';
import { runRules } from '../../src/pipeline';
import { readWorkbook } from '../../src/io/read';
import { extractTable } from '../../src/io/extractTable';
import type { V } from './analyze/helpers';
import { externalOnlyPair, mixedPair, simplePair, unrelatedPair, xlsxBytesOf, type Pair } from './v5fixtures';

interface Spy {
  calls: LearnPayload[];
  callLearn: LearnFromExamplesOptions['callLearn'];
}

/** A callLearn that records its payloads and returns nothing usable (these tests don't need the AI's answer). */
function spy(answer: LearnResult | null = null): Spy {
  const calls: LearnPayload[] = [];
  return {
    calls,
    callLearn: async (payload): Promise<LearnCallResult> => {
      calls.push(payload);
      return { rules: answer, problems: [], calls: [] };
    },
  };
}

async function learn(pair: Pair, opts: Partial<LearnFromExamplesOptions> & { s: Spy }) {
  const { s, ...rest } = opts;
  return learnFromExamples({
    input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' },
    masking: false,
    tier: 'paid',
    callLearn: s.callLearn,
    ...rest,
  });
}

describe('learnFromExamples: a signed-out caller (ai: notAllowed) never reaches the LLM', () => {
  it('the strict fast path still finishes a simple pair, as local', async () => {
    const s = spy();
    const r = await learn(simplePair(), { ai: 'notAllowed', s });
    expect(r.path).toBe('local');
    expect(r.verification?.verified).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  it('a pair that needs the AI step gets the partial result: rules for what code explained, verified on those columns', async () => {
    const s = spy();
    const r = await learn(mixedPair(), { ai: 'notAllowed', s });
    expect(s.calls).toHaveLength(0);
    expect(r.path).toBe('partial');
    expect(r.calls).toEqual([]);
    expect(r.partial).toEqual({
      reason: 'aiNotAllowed',
      solved: ['Item', 'Ref', 'Total'],
      needsAi: ['Label'],
      external: ['Warehouse'],
      solvedColumns: [0, 1, 2],
      needsAiParts: [],
    });
    expect(r.rules?.output.columns.map((c) => c.from === null)).toEqual([false, false, false, true, true]);
    expect(r.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
    expect(r.verification).toMatchObject({ verified: true, matched: 20, total: 20 });
    expect(r.readiness).toEqual({ ready: true });
    expect(r.stages).toMatchObject({ fastPathTried: true, fastPathSucceeded: false, readinessChecked: true, readinessBlocked: false, partialBuilt: true, llmCalled: false });
  });

  it('the partial rules run on the input file', async () => {
    const s = spy();
    const r = await learn(mixedPair(), { ai: 'notAllowed', s });
    const wb = await readWorkbook(await xlsxBytesOf(mixedPair().input), 'in.xlsx');
    const extracted = extractTable(wb, r.rules!.input);
    if (!extracted.ok) throw new Error('extract failed');
    const run = runRules(r.rules!, extracted.table);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.summary.rowsOut).toBe(20);
  });

  it('when only external columns are left, the partial result says so (nothing to sign in for)', async () => {
    const s = spy();
    const r = await learn(externalOnlyPair(), { ai: 'notAllowed', s });
    expect(r.path).toBe('partial');
    expect(r.partial).toMatchObject({ reason: 'onlyExternalColumns', needsAi: [], external: ['Warehouse'] });
    expect(s.calls).toHaveLength(0);
  });

  it('still shows the partial result when the AI step would be blocked for another reason, with the reason', async () => {
    const s = spy();
    const r = await learn(wide(mixedPair(), 62), { ai: 'notAllowed', s });
    expect(r.path).toBe('partial');
    expect(r.partial?.reason).toBe('aiNotAllowed');
    expect(r.readiness).toMatchObject({ ready: false, issues: [{ code: 'inputColumnsTooMany', params: { limit: 60 } }] });
    expect(s.calls).toHaveLength(0);
  });

  it('a pre-flight block is still a block', async () => {
    const s = spy();
    const r = await learn(unrelatedPair(), { ai: 'notAllowed', s });
    expect(r.path).toBe('blocked');
    expect(r.rules).toBeNull();
  });
});

describe('learnFromExamples: the AI readiness gate (ai allowed)', () => {
  it('a pair that needs the AI step is ready: the LLM is called with the payload the gate built', async () => {
    const s = spy();
    const r = await learn(mixedPair(), { s });
    expect(s.calls).toHaveLength(1);
    expect(r.path).toBe('llm');
    expect(r.readiness).toEqual({ ready: true });
    expect(r.stages).toMatchObject({ readinessChecked: true, readinessBlocked: false, llmCalled: true, partialBuilt: false });
    expect(s.calls[0]!.skipColumns).toEqual([4]);
  });

  it('is the default: leaving out `ai` means allowed', async () => {
    const s = spy();
    await learn(mixedPair(), { ai: 'allowed', s });
    expect(s.calls).toHaveLength(1);
  });

  it('only external columns left: finishes locally with no LLM call, those columns "need your input"', async () => {
    const s = spy();
    const r = await learn(externalOnlyPair(), { s });
    expect(s.calls).toHaveLength(0);
    expect(r.path).toBe('partial');
    expect(r.partial).toMatchObject({ reason: 'onlyExternalColumns', solved: ['Item', 'Ref', 'Total'], needsAi: [], external: ['Warehouse'], needsAiParts: [] });
    expect(r.unsupported).toEqual([{ outputColumn: 'Warehouse', reasonCode: 'externalData' }]);
    expect(r.verification).toMatchObject({ verified: true, matched: 20, total: 20 });
    expect(r.readiness).toEqual({ ready: false, issues: [{ code: 'onlyExternalColumns', params: { count: 1, columns: 'Warehouse' } }] });
    expect(r.stages).toMatchObject({ llmCalled: false, partialBuilt: true, readinessBlocked: false });
  });

  it('attach mode keeps calling the AI step even when only external columns are left', async () => {
    const s = spy();
    const target: Format = formatOf({
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'item', header: 'Item', type: 'text' }] },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Item', from: 'item' }] },
      validations: [],
      unsupported: [],
      assumptions: [],
    });
    const r = await learn(externalOnlyPair(), { s, target });
    expect(s.calls).toHaveLength(1);
    expect(r.path).toBe('llm');
  });

  it('a payload that cannot fit its caps stops before the LLM: notReady, nothing consumed, the part that is too large', async () => {
    const s = spy();
    const r = await learn(wide(mixedPair(), 62), { s });
    expect(s.calls).toHaveLength(0);
    expect(r.path).toBe('notReady');
    expect(r.rules).toBeNull();
    expect(r.verification).toBeNull();
    expect(r.readiness).toMatchObject({ ready: false, issues: [{ code: 'inputColumnsTooMany', params: { count: 67, limit: 60 } }] });
    expect(r.stages).toMatchObject({ readinessChecked: true, readinessBlocked: true, llmCalled: false });
  });

  it('a pair with unmatched rows still goes to the LLM after "try anyway" (30% unmatched is not a block)', async () => {
    const m = mixedPair(20);
    const output = m.output.map((row, i): V[] => (i >= 1 && i <= 6 ? [`Ghost ${i}`, `GHOST-${i}`, row[2]!, row[3]!, row[4]!] : row));
    const stopped = spy();
    const noTry = await learn({ input: m.input, output }, { s: stopped });
    expect(noTry.path).toBe('blocked');
    expect(stopped.calls).toHaveLength(0);

    const s = spy();
    const r = await learn({ input: m.input, output }, { s, tryAnyway: true });
    expect(r.path).toBe('llm');
    expect(s.calls).toHaveLength(1);
  });

  it('a signed-out caller with unmatched rows who tries anyway gets the partial result, still no LLM', async () => {
    const m = mixedPair(20);
    const output = m.output.map((row, i): V[] => (i >= 1 && i <= 6 ? [`Ghost ${i}`, `GHOST-${i}`, row[2]!, row[3]!, row[4]!] : row));
    const s = spy();
    const r = await learn({ input: m.input, output }, { s, tryAnyway: true, ai: 'notAllowed' });
    expect(r.path).toBe('partial');
    expect(s.calls).toHaveLength(0);
  });
});

/** The pair with extra input columns, so the input has more columns than the payload allows (60). */
function wide(pair: Pair, extra: number): Pair {
  const input = pair.input.map((row, r) => [...row, ...Array.from({ length: extra }, (_, k): V => (r === 0 ? `Extra ${k}` : `E${k}-${r * 31 + k}`))]);
  return { input, output: pair.output };
}
