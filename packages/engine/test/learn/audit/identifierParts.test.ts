// Engine audit (2026-10-07), fix 3: identifier status passed only through `copy` and `normalize` (`classify.ts`). The 5-digit tail of a
// numeric Israeli ID was classed `measure` and sent real. Now every relation that keeps part of the value passes it (substr, split,
// padLeft, numberFormat both ways; a concat or template from an identifier input).
import type { PayloadCell } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { classifyColumns } from '../../../src/learn/classify';
import { createMasker } from '../../../src/learn/mask';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { makeValidIsraeliId } from '../../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const N = 14;
const ids = Array.from({ length: N }, (_, i) => Number(makeValidIsraeliId(String(31234500 + i * 7919).padStart(8, '0'))));
const tail = (id: number): number => id % 100000;

function samplesOut(a: ReturnType<typeof analyzeOk>, col: number): PayloadCell[] {
  const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(new TextEncoder().encode('parts')) });
  return payload.samples.map((s) => (s.out as PayloadCell[])[col]!);
}

describe('a part of an identifier is an identifier', () => {
  it('substr: the last 5 digits of a numeric Israeli ID are masked', () => {
    const input: V[][] = [['ID Number', 'Amount'], ...ids.map((id, i) => [id, 100 + i * 13])];
    const output: V[][] = [['Tail', 'Amount'], ...ids.map((id, i) => [tail(id), 100 + i * 13])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.columns[0]!.relations.some((r) => r.rel === 'substr')).toBe(true);
    expect(classifyColumns(a).output).toEqual(['identifier', 'measure']);
    const sent = samplesOut(a, 0);
    expect(sent.length).toBeGreaterThan(0);
    for (const v of sent) expect(ids.map(tail)).not.toContain(v);
    // (the amount, a measure, stays real)
    expect(classifyColumns(a).input[1]).toBe('measure');
  });

  it('split: a part of an account number written with separators', () => {
    const accounts = ids.map((id, i) => `${10 + (i % 3)}-${tail(id)}-${i % 7}`);
    const input: V[][] = [['Account', 'Qty'], ...accounts.map((acc, i) => [acc, i + 1])];
    const output: V[][] = [['Part', 'Qty'], ...accounts.map((acc, i) => [Number(acc.split('-')[1]), i + 1])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.columns[0]!.relations.some((r) => r.rel === 'split')).toBe(true);
    expect(a.output.profile[0]!.type).toBe('integer');
    expect(classifyColumns(a).output[0]).toBe('identifier');
  });

  it('template: an identifier inside fixed text makes the output an identifier; an amount beside it stays a measure', () => {
    const input: V[][] = [['Customer No', 'Price'], ...ids.map((id, i) => [100200 + i, 10 + i])];
    const output: V[][] = [['Ref', 'Price'], ...ids.map((_, i) => [`C-${100200 + i}`, 10 + i])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(classifyColumns(a).output[0]).toBe('identifier');
    expect(classifyColumns(a).input[1]).toBe('measure');
  });

  it('substr back: an output named as an identifier makes the input it is cut from an identifier too', () => {
    const input: V[][] = [['Number', 'Qty'], ...ids.map((_, i) => [512345 + i * 1037, i + 1])];
    const output: V[][] = [['Customer No', 'Qty'], ...ids.map((_, i) => [Number(String(512345 + i * 1037).slice(0, 4)), i + 1])];
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.columns[0]!.relations.some((r) => r.rel === 'substr')).toBe(true);
    expect(classifyColumns(a).input).toEqual(['identifier', 'measure']);
  });
});
