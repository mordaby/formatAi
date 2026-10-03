// Composition (SPEC 6.2 step 4, owner rule: if the AI can solve a column, let it; only data with no relation to the
// input is external): an output TEXT column composed from input values but beyond the light `template` (three input
// columns, or longer fixed text) is `derived` (kind `composition`), not external. Its input columns are the ones
// whose value sits inside the output cell on >= limits.learn.compositionMinCoverage of the rows, in order of first
// appearance. Synthetic, domain-neutral data.
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { isDerivedColumn, isExternalColumn, type PairAnalysis } from '../../../src/learn/analyze';
import { aiReadiness } from '../../../src/learn/readiness';
import { learnFromExamples, type LearnCallResult } from '../../../src/learn/flow';
import { relationsToHints } from '../../../src/learn/hints';
import { createMasker } from '../../../src/learn/mask';
import { partialRules } from '../../../src/learn/partial';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, rng, xlsx, type V } from './helpers';
import { xlsxBytesOf, type Pair } from '../v5fixtures';

const FIRSTS = ['Dana', 'Omer', 'Noa', 'Yael', 'Tamar', 'Eitan', 'Lior', 'Maya', 'Amit', 'Shira', 'Ron', 'Gal'];
const LASTS = ['Cohen', 'Levi', 'Mizrahi', 'Katz', 'Peretz', 'Bar', 'Avraham', 'Dahan', 'Golan', 'Segal'];

const N = 24;
const idOf = (i: number): number => 312345002 + i * 7;

/** Input: Ref, Cust (a 9-digit number), First, Last, Dept (1-letter codes, 3 values). Output: Ref + one composed column. */
function pairWith(composed: (i: number, first: string, last: string) => string, name = 'Label'): Pair {
  const input: V[][] = [['Ref', 'Cust', 'First', 'Last', 'Dept']];
  const output: V[][] = [['Ref', name]];
  for (let i = 0; i < N; i++) {
    const first = FIRSTS[i % FIRSTS.length]!;
    const last = LASTS[(i * 3) % LASTS.length]!;
    const ref = `R-${1000 + i * 7}`;
    input.push([ref, idOf(i), first, last, ['A', 'B', 'C'][i % 3]!]);
    output.push([ref, composed(i, first, last)]);
  }
  return { input, output };
}

function analyze(pair: Pair): PairAnalysis {
  return analyzeOk(xlsx(pair.input), xlsx(pair.output));
}

function labelOf(a: PairAnalysis, header = 'Label') {
  const ca = a.columns.find((c) => c.header === header);
  if (!ca) throw new Error(`no column ${header}`);
  return ca;
}

describe('the probe variants', () => {
  it('2 columns with short fixed text is still a template (or a concat), not derived', () => {
    const t = labelOf(analyze(pairWith((i, first) => `[${idOf(i)}] ${first}.`)));
    expect(t.unknown).toBe(false);
    expect(t.relations[0]).toMatchObject({ rel: 'template', in: [1, 2] });
    expect(t.derived).toBeNull();
    const c = labelOf(analyze(pairWith((i, first) => `${idOf(i)} - ${first}`)));
    expect(c.unknown).toBe(false);
    expect(c.relations[0]).toMatchObject({ rel: 'concat', in: [1, 2] });
    expect(c.derived).toBeNull();
  });

  it('3 columns (`312345002 - Dana Cohen`): derived composition of the right columns, in the order they appear', () => {
    const c = labelOf(analyze(pairWith((i, first, last) => `${idOf(i)} - ${first} ${last}`)));
    expect(c.unknown).toBe(true);
    expect(c.relations).toEqual([]);
    expect(isDerivedColumn(c)).toBe(true);
    expect(isExternalColumn(c)).toBe(false);
    expect(c.derived).toMatchObject({ kind: 'composition', in: [1, 2, 3], coverage: 1, failCount: 0, failing: [] });
  });

  it('the order is the order of first appearance in the output text, not the input order', () => {
    const c = labelOf(analyze(pairWith((i, first, last) => `${last}, ${first} (${idOf(i)})`)));
    expect(c.derived).toMatchObject({ kind: 'composition', in: [3, 2, 1] });
  });

  it('long fixed text (`Customer number 312345002: Cohen`): derived composition of the two columns', () => {
    const c = labelOf(analyze(pairWith((i, _first, last) => `Customer number ${idOf(i)}: ${last}`)));
    expect(isDerivedColumn(c)).toBe(true);
    expect(c.derived).toMatchObject({ kind: 'composition', in: [1, 3], coverage: 1 });
  });

  it('case and spacing do not matter (the normalized values are compared)', () => {
    const c = labelOf(analyze(pairWith((i, first, last) => `${idOf(i)} - ${first.toUpperCase()}  ${last.toUpperCase()}`)));
    expect(c.derived).toMatchObject({ kind: 'composition', in: [1, 2, 3] });
  });

  it('a truly external column stays external', () => {
    const r = rng(77);
    const c = labelOf(analyze(pairWith(() => `Note ${100 + Math.floor(r() * 9000)}-${'xyzqw'[Math.floor(r() * 5)]}`)));
    expect(c.unknown).toBe(true);
    expect(c.derived).toBeNull();
    expect(isExternalColumn(c)).toBe(true);
  });

  it('a column holding only 1-character codes is not a composition: it stays external', () => {
    const r = rng(78);
    // The output contains the Dept code (A / B / C) on every row, plus an unrelated number.
    const c = labelOf(analyze(pairWith((i) => `Zone ${['A', 'B', 'C'][i % 3]}${100 + Math.floor(r() * 9000)}`)));
    expect(c.derived).toBeNull();
    expect(isExternalColumn(c)).toBe(true);
  });

  it('fixed text that is also a constant input column is fixed text, not evidence', () => {
    const r = rng(79);
    const pair = pairWith(() => `ISR-${100 + Math.floor(r() * 9000)}`);
    const input = pair.input.map((row, k) => [...row, k === 0 ? 'Country' : 'ISR']);
    const c = labelOf(analyze({ input, output: pair.output }));
    expect(c.derived).toBeNull();
  });

  it('a short value that sits in most output cells by chance is not evidence', () => {
    // 2-letter tags inside long free text: the tag is also inside most OTHER rows' text.
    const r = rng(80);
    const words = ['onion', 'fox', 'quit', 'box', 'union', 'ton'];
    const pair = pairWith(() => `Details: ${words.join(' ')} ${Math.floor(r() * 90000)}`);
    const input = pair.input.map((row, k) => [...row, k === 0 ? 'Tag' : ['on', 'ox', 'ui'][(k * 7) % 3]!]);
    const c = labelOf(analyze({ input, output: pair.output }));
    expect(c.derived).toBeNull();
  });

  it('a few exceptions are fine (>= 90% of the rows) and the hint says where it fails', () => {
    const pair = pairWith((i, first, last) => (i === 5 ? `${idOf(i)} - ${first}` : `${idOf(i)} - ${first} ${last}`));
    const c = labelOf(analyze(pair));
    expect(c.derived).toMatchObject({ kind: 'composition', in: [1, 2, 3], failCount: 1 });
    expect(c.derived!.coverage).toBeCloseTo((N - 1) / N, 10);
    expect(c.derived!.failing).toEqual([5]);
  });

  it('a value contained on fewer rows than the floor is not an input of the composition', () => {
    // First name present everywhere, last name only on 50% of the rows.
    const pair = pairWith((i, first, last) => `${idOf(i)} - ${first}${i % 2 === 0 ? ` ${last}` : ''}`);
    const c = labelOf(analyze(pair));
    expect(c.derived).toMatchObject({ kind: 'composition', in: [1, 2] });
    expect(limits.learn.compositionMinCoverage).toBe(0.9);
  });

  it('an output with no input value inside it is not a composition', () => {
    const r = rng(81);
    const c = labelOf(analyze(pairWith(() => String(1000 + Math.floor(r() * 90000)))));
    expect(c.derived).toBeNull();
  });
});

describe('hints, pre-flight, readiness and the partial result', () => {
  const pair = pairWith((i, first, last) => `${idOf(i)} - ${first} ${last}`);
  const a = analyze(pair);
  const pf = preflight(a, 'paid');

  it('pre-flight does not skip it and does not warn about unknown columns', () => {
    expect(pf.skipColumns).toEqual([]);
    expect(pf.issues).toEqual([]);
  });

  it('a `contains` hint lists the columns, with the coverage', () => {
    const hints = relationsToHints(a, pf);
    expect(hints.find((h) => 'out' in h && h.out === 1)).toEqual({ rel: 'contains', in: [1, 2, 3], out: 1, coverage: 1 });
  });

  it('with an exception row, the hint says where it fails (failsOn points at a sample)', () => {
    const b = analyze(pairWith((i, first, last) => (i === 5 ? `${idOf(i)} - ${first}` : `${idOf(i)} - ${first} ${last}`)));
    const { payload } = buildPayload(b, preflight(b, 'paid'));
    const hint = payload.hints.find((h) => 'out' in h && h.out === 1)!;
    expect(hint).toMatchObject({ rel: 'contains', in: [1, 2, 3] });
    expect(hint.failsOn).toHaveLength(1);
  });

  it('masking changes nothing about the hint (it holds no values)', () => {
    const masker = createMasker(new TextEncoder().encode('composition-test-key'));
    const open = buildPayload(a, pf).payload.hints.find((h) => 'out' in h && h.out === 1);
    const masked = buildPayload(a, pf, { masker }).payload;
    expect(masked.hints.find((h) => 'out' in h && h.out === 1)).toEqual(open);
    expect(JSON.stringify(masked)).not.toContain('Cohen');
  });

  it('the AI readiness gate lets the AI step run, and the partial result says it needs it', () => {
    expect(aiReadiness(a, pf).ready).toBe(true);
    const p = partialRules(a, pf);
    if ('reason' in p) throw new Error('unreachable');
    expect(p.needsAi).toEqual(['Label']);
    expect(p.external).toEqual([]);
  });

  it('one composed and one external column: nothing is skipped (the external one is only noted)', () => {
    const r = rng(5);
    const withExternal: Pair = {
      input: pair.input,
      output: pair.output.map((row, i) => [...row, i === 0 ? 'Dock' : `D${100 + Math.floor(r() * 800)}`]),
    };
    const b = analyze(withExternal);
    expect(preflight(b, 'paid').skipColumns).toEqual([]);
    expect(isDerivedColumn(labelOf(b))).toBe(true);
    expect(isExternalColumn(labelOf(b, 'Dock'))).toBe(true);
  });
});

describe('learnFromExamples: a composed column reaches the AI step', () => {
  const pair = pairWith((i, first, last) => `${idOf(i)} - ${first} ${last}`);

  async function run(ai: 'allowed' | 'notAllowed') {
    const calls: unknown[] = [];
    const res = await learnFromExamples({
      input: { bytes: await xlsxBytesOf(pair.input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(pair.output), name: 'out.xlsx' },
      masking: false,
      tier: 'paid',
      ai,
      callLearn: async (payload): Promise<LearnCallResult> => {
        calls.push(payload);
        return { rules: null, problems: [], calls: [] };
      },
    });
    return { res, calls };
  }

  it('signed in: the learn call is made, with the contains hint and no skipColumns', async () => {
    const { res, calls } = await run('allowed');
    expect(res.path).toBe('llm');
    expect(calls).toHaveLength(1);
    const payload = calls[0] as { hints: { rel: string; in?: number[] }[]; skipColumns?: number[] };
    expect(payload.hints.find((h) => h.rel === 'contains')).toMatchObject({ in: [1, 2, 3] });
    expect(payload.skipColumns).toBeUndefined();
  });

  it('signed out: the partial result lists the column as needing the AI step, and no call is made', async () => {
    const { res, calls } = await run('notAllowed');
    expect(calls).toHaveLength(0);
    expect(res.path).toBe('partial');
    expect(res.partial).toMatchObject({ reason: 'aiNotAllowed', needsAi: ['Label'], external: [] });
  });
});
