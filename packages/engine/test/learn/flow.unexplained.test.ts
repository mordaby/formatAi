// Policy (owner, 2026-10-01): "code found no relation" is not certainty. A column no detector explains - here a text column built from
// input values with a REFORMATTED number and a reformatted ID, so neither the template nor the composition detector (a value found inside the
// output cell) recognizes it - is internally "external", but it is NEVER taken away from the AI step:
//   - signed in: the AI step is called with the column as a normal output column (not in `skipColumns`), also when it is the ONLY thing left;
//   - signed out: the partial result lists it as "needs the AI step" (marked `external`: "may come from another source"), never as finished;
//   - pre-flight only NOTES it (severity 'info'), no warn status, no gate.
import type { LearnPayload } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { isExternalColumn, type PairAnalysis } from '../../src/learn/analyze';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { aiReadiness } from '../../src/learn/readiness';
import { completionPlan } from '../../src/learn/complete';
import { partialRules } from '../../src/learn/partial';
import { preflight } from '../../src/learn/preflight';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { xlsxBytesOf, type Pair } from './v5fixtures';

const fmt = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Input: Ref, ID (a 9-digit text with a leading zero), Amount. Output: Ref + `Note`, e.g. `ID 040-217-763 - total 1,234.50`. */
function composedPair(extraCopy = false): Pair {
  const input: V[][] = [['Ref', 'ID', 'Amount']];
  const output: V[][] = [extraCopy ? ['Ref', 'Note'] : ['Note']];
  for (let i = 0; i < 24; i++) {
    const ref = `R-${1000 + i * 7}`;
    const id = String(40217763 + i * 7919).padStart(9, '0');
    const amount = 1234.5 + i * 311.25;
    input.push([ref, id, amount]);
    const note = `ID ${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)} - total ${fmt(amount)}`;
    output.push(extraCopy ? [ref, note] : [note]);
  }
  return { input, output };
}

const analysisOf = (pair: Pair): PairAnalysis => analyzeOk(xlsx(pair.input), xlsx(pair.output));

async function run(pair: Pair, ai: 'allowed' | 'notAllowed') {
  const payloads: LearnPayload[] = [];
  const res = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' },
    masking: false,
    tier: 'paid',
    ai,
    callLearn: async (payload): Promise<LearnCallResult> => {
      payloads.push(payload);
      return { rules: null, problems: [], calls: [] };
    },
  });
  return { res, payloads };
}

describe('a column no detector explains (the owner\'s case): the pair', () => {
  it('is the "external" class internally (no relation, no dependency, no composition)', () => {
    const a = analysisOf(composedPair(true));
    const note = a.columns.find((c) => c.header === 'Note')!;
    expect(note.unknown).toBe(true);
    expect(isExternalColumn(note)).toBe(true);
  });

  it('pre-flight only notes it: severity info, status ok, nothing to skip (the Ref column is traced, so it is not the "nothing traced" block)', () => {
    const pf = preflight(analysisOf(composedPair(true)), 'paid');
    expect(pf.status).toBe('ok');
    expect(pf.skipColumns).toEqual([]);
    expect(pf.issues).toEqual([{ code: 'unknownOutputColumns', severity: 'info', params: { count: 1 } }]);
  });

  it('the readiness gate lets the AI step run, with nothing in skipColumns', () => {
    const a = analysisOf(composedPair(true));
    const r = aiReadiness(a, preflight(a, 'paid'));
    expect(r.ready).toBe(true);
    expect(r.ready && r.built?.payload.skipColumns).toBeUndefined();
  });
});

describe('signed in: the AI step is called', () => {
  it('with the column as a normal output column, not in skipColumns - also when it is the only column the AI has to do', async () => {
    const { res, payloads } = await run(composedPair(true), 'allowed');
    expect(payloads).toHaveLength(1);
    expect(res.path).toBe('llm');
    expect(payloads[0]!.output.columns.map((c) => c.header)).toEqual(['Ref', 'Note']);
    expect(payloads[0]!.skipColumns).toBeUndefined();
    expect(res.stages).toMatchObject({ llmCalled: true, partialBuilt: false, readinessBlocked: false });
    expect(res.partial).toBeUndefined();
  });
});

describe('signed out: the partial result', () => {
  it('lists the column as needing the AI step (marked external for the wording only), no call, nothing finished locally', async () => {
    const { res, payloads } = await run(composedPair(true), 'notAllowed');
    expect(payloads).toHaveLength(0);
    expect(res.path).toBe('partial');
    expect(res.partial).toMatchObject({ reason: 'aiNotAllowed', solved: ['Ref'], needsAi: ['Note'], external: ['Note'], needsAiParts: [] });
    // Only the AI step may say "this column cannot be produced": the local rules do not.
    expect(res.unsupported).toEqual([]);
    expect(res.rules?.output.columns.map((c) => [c.header, c.from === null])).toEqual([['Ref', false], ['Note', true]]);
  });

  it('the partial result builder agrees (needsAi includes the external column)', () => {
    const a = analysisOf(composedPair(true));
    const p = partialRules(a, preflight(a, 'paid'));
    if ('reason' in p) throw new Error('no partial');
    expect(p.needsAi).toEqual(['Note']);
    expect(p.external).toEqual(['Note']);
    expect(p.rules.unsupported).toEqual([]);
  });
});

describe('what the AI step is asked to complete', () => {
  it('every column with no rule, the unexplained one too', () => {
    const a = analysisOf(composedPair(true));
    const p = partialRules(a, preflight(a, 'paid'));
    if ('reason' in p) throw new Error('no partial');
    expect(completionPlan(p.rules).columns).toEqual([1]);
  });
});
