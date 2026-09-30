// aiReadiness (SPEC 21 v5 item 4): the AI readiness gate. It is deliberately minimal - it stops only what is
// certain to fail even with the AI (no matched rows; a payload over its caps), sends "only external columns
// left" to the local finish instead of the LLM, and lets every ambiguous case through.
import { AI_READINESS_ISSUE_CODES, aiReadinessMessages, limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { partialRules } from '../../src/learn/partial';
import { aiReadiness } from '../../src/learn/readiness';
import { buildPayload } from '../../src/learn/payload';
import { createMasker } from '../../src/learn/mask';
import { preflight } from '../../src/learn/preflight';
import { analyzeOk, date, rng, xlsx, type V } from './analyze/helpers';
import { analyzeWithPreflight, externalOnlyPair, mixedPair, unrelatedPair } from './v5fixtures';

describe('aiReadiness: ready', () => {
  it('a pair that needs the AI step is ready, and the payload it built is the payload buildPayload builds', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    const r = aiReadiness(a, pf);
    expect(r.ready).toBe(true);
    if (!r.ready) return;
    expect(r.built?.payload).toEqual(buildPayload(a, pf).payload);
  });

  it('builds the payload with the masker it is given (the size checked is the size sent)', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    const masker = createMasker(new TextEncoder().encode('readiness-test'));
    const r = aiReadiness(a, pf, { masker });
    expect(r.ready).toBe(true);
    if (r.ready) expect(r.built?.payload.masking).toBe(true);
  });
});

describe('aiReadiness: no rows matched (a block)', () => {
  it('no output row matches an input row: nothing to learn from', () => {
    const p = unrelatedPair();
    const a = analyzeOk(xlsx(p.input), xlsx(p.output));
    expect(a.alignment.rows).toHaveLength(0);
    const r = aiReadiness(a, preflight(a, 'paid'));
    expect(r).toEqual({ ready: false, issues: [{ code: 'noRowsMatched' }] });
  });
});

describe('aiReadiness: only external columns left (no LLM call, not a block)', () => {
  it('reports it, with the count and the headers', () => {
    const { a, pf } = analyzeWithPreflight(externalOnlyPair());
    expect(aiReadiness(a, pf)).toEqual({ ready: false, issues: [{ code: 'onlyExternalColumns', params: { count: 1, columns: 'Warehouse' } }] });
  });

  it('lists several external columns, joined', () => {
    const { input, output } = externalOnlyPair();
    const r = rng(5);
    const out2: V[][] = output.map((row, i) => (i === 0 ? [...row, 'Dock'] : [...row, `D${100 + Math.floor(r() * 800)}`]));
    const { a, pf } = analyzeWithPreflight({ input, output: out2 });
    const res = aiReadiness(a, pf);
    expect(res).toEqual({ ready: false, issues: [{ code: 'onlyExternalColumns', params: { count: 2, columns: 'Warehouse, Dock' } }] });
  });

  it('is not the case when a column also needs the AI step', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    expect(a.columns.filter((c) => c.unknown).map((c) => c.header)).toEqual(['Warehouse']);
    expect(aiReadiness(a, pf).ready).toBe(true);
  });

  it('is not the case when layout still needs the AI step (a sort the code does not build)', () => {
    const { input, output } = externalOnlyPair();
    const [head, ...body] = output;
    body.sort((x, y) => ((x[0] as string) < (y[0] as string) ? 1 : -1));
    const { a, pf } = analyzeWithPreflight({ input, output: [head!, ...body] });
    expect(a.layout.sort).not.toBeNull();
    expect(aiReadiness(a, pf).ready).toBe(true);
  });

  it('does not apply in attach mode: the AI step is told to copy the target format, so it still runs', () => {
    const { a, pf } = analyzeWithPreflight(externalOnlyPair());
    const target = {
      output: { columns: [], titleRows: [], summaryRows: [], sheetName: 'Sheet1', direction: 'ltr', language: 'en' },
      layout: { sort: [] },
      outputValidations: [],
    };
    const r = aiReadiness(a, pf, { target: target as never });
    expect(r.ready).toBe(true);
  });

  it('reuses a partial result it is given; with none to be had (null) it cannot tell, so the AI step runs', () => {
    const { a, pf } = analyzeWithPreflight(externalOnlyPair());
    const partial = partialRules(a, pf);
    if ('reason' in partial) throw new Error('unreachable');
    expect(aiReadiness(a, pf, { partial })).toEqual(aiReadiness(a, pf));
    expect(aiReadiness(a, pf, { partial: null }).ready).toBe(true);
  });
});

describe('aiReadiness: the payload does not fit its caps (a block)', () => {
  const caps = { ...limits.payload };

  it('too many input columns', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    expect(a.input.columnCount).toBe(5);
    const r = aiReadiness(a, pf, { caps: { ...caps, maxColumns: 4 } });
    expect(r).toEqual({
      ready: false,
      issues: [
        { code: 'inputColumnsTooMany', params: { count: 5, limit: 4 } },
        { code: 'outputColumnsTooMany', params: { count: 5, limit: 4 } },
      ],
    });
  });

  it('too many output columns only', () => {
    const input: V[][] = [['Ref', 'Item']];
    const output: V[][] = [['Ref', 'Item', 'Item again', 'Ref again']];
    for (let i = 0; i < 8; i++) {
      input.push([`R-${100 + i * 3}`, `Thing ${i}`]);
      output.push([`R-${100 + i * 3}`, `Thing ${i}`, `Thing ${i}`, `R-${100 + i * 3}`]);
    }
    const { a, pf } = analyzeWithPreflight({ input, output });
    const r = aiReadiness(a, pf, { caps: { ...caps, maxColumns: 3 } });
    expect(r).toEqual({ ready: false, issues: [{ code: 'outputColumnsTooMany', params: { count: 4, limit: 3 } }] });
  });

  it('a payload over the byte cap after trimming', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    const r = aiReadiness(a, pf, { caps: { ...caps, maxBytes: 300 } });
    expect(r.ready).toBe(false);
    if (r.ready) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.code).toBe('payloadTooLarge');
    expect(r.issues[0]!.params).toMatchObject({ limitKb: 0 });
    expect(r.issues[0]!.params!.kb).toBeGreaterThan(0);
  });

  it('the default caps let an ordinary pair through', () => {
    const { a, pf } = analyzeWithPreflight(mixedPair());
    expect(aiReadiness(a, pf).ready).toBe(true);
  });
});

describe('aiReadiness: what is NOT a block - the LLM gets these', () => {
  it('only two aligned rows', () => {
    const input: V[][] = [['Ref', 'Qty'], ['A-11', 4], ['A-23', 9]];
    const output: V[][] = [['Ref', 'Double'], ['A-11', 8], ['A-23', 18]];
    const { a, pf } = analyzeWithPreflight({ input, output });
    expect(a.alignment.rows).toHaveLength(2);
    expect(aiReadiness(a, pf).ready).toBe(true);
  });

  it('30% of the example output rows unmatched to an input row', () => {
    const m = mixedPair(20);
    const output = m.output.map((r, i) => (i >= 1 && i <= 6 ? [`Ghost ${i}`, `GHOST-${i}`, r[2]!, r[3]!, r[4]!] : r));
    const a = analyzeOk(xlsx(m.input), xlsx(output));
    expect(a.alignment.unalignedOut).toHaveLength(6);
    expect(aiReadiness(a, preflight(a, 'paid')).ready).toBe(true);
  });

  // A column whose values can't be read the same way is not a block of its own. When the analysis can't
  // trace it at all it is treated like any untraceable column (the AI is told to skip it, as before): the
  // AI still runs when other work is left, and the local finish names the column when it is all that's left.
  function twoFormatDates(extra: boolean) {
    const input: V[][] = [['Ref', 'When', 'Group']];
    const output: V[][] = [extra ? ['Ref', 'Date', 'Label'] : ['Ref', 'Date']];
    for (let i = 0; i < 20; i++) {
      const day = 3 + i;
      const text = i % 2 === 0 ? `${String(day).padStart(2, '0')}/05/2024` : `2024-05-${String(day).padStart(2, '0')}`;
      const group = ['North', 'South', 'East'][i % 3]!;
      input.push([`X-${100 + i * 7}`, text, group]);
      const row: V[] = [`X-${100 + i * 7}`, date(2024, 5, day)];
      if (extra) row.push(i === 4 ? 'Special' : group);
      output.push(row);
    }
    return analyzeWithPreflight({ input, output });
  }

  it('a date column written in two formats, with other work left for the AI', () => {
    const { a, pf } = twoFormatDates(true);
    expect(a.input.profile[1]!.type).toBe('text');
    expect(aiReadiness(a, pf).ready).toBe(true);
  });

  it('a date column written in two formats that is all that is left: the local finish names it', () => {
    const { a, pf } = twoFormatDates(false);
    expect(aiReadiness(a, pf)).toEqual({ ready: false, issues: [{ code: 'onlyExternalColumns', params: { count: 1, columns: 'Date' } }] });
  });

  it('a column with many values that are not numbers', () => {
    const input: V[][] = [['Ref', 'Amount', 'Group']];
    const output: V[][] = [['Ref', 'Amount x2', 'Label']];
    for (let i = 0; i < 20; i++) {
      const amount: V = i % 3 === 1 ? 'n/a' : 10 + i * 3.5;
      const group = ['North', 'South', 'East'][i % 3]!;
      input.push([`X-${100 + i * 7}`, amount, group]);
      output.push([`X-${100 + i * 7}`, typeof amount === 'number' ? amount * 2 : 'n/a', i === 4 ? 'Special' : group]);
    }
    const { a, pf } = analyzeWithPreflight({ input, output });
    expect(aiReadiness(a, pf).ready).toBe(true);
  });
});

describe('aiReadiness: codes and messages', () => {
  it('every code the gate can return has a he and en message', () => {
    for (const code of AI_READINESS_ISSUE_CODES) {
      expect(aiReadinessMessages[code].en.length, code).toBeGreaterThan(10);
      expect(aiReadinessMessages[code].he.length, code).toBeGreaterThan(10);
    }
  });
});
