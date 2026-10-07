// Engine audit (2026-10-07), fix 5: a filter's cut-off (`dropped.ts`) and a band's thresholds (`derived.ts`) are values of their column -
// the edge of the gap when no rounder number fits - and, unlike `stats.range`, they were sent real on an identifier column. Now a hint on
// an identifier column keeps its comparison or its bands, never the value.
import type { Band } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { classifyColumns } from '../../../src/learn/classify';
import { createMasker } from '../../../src/learn/mask';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);
// Customer numbers with gaps no round number fills, so a cut-off is a real one (373817 | 373818).
const CUSTOMERS = [373801, 373806, 373809, 373811, 373817, 373818, 373833, 373838, 373844, 373851, 373857, 373862, 373869, 373874, 373880, 373887];
const CUT = 373818;

function filterPair(header: string) {
  const input: V[][] = [[header, 'Name']];
  const output: V[][] = [[header, 'Name']];
  CUSTOMERS.forEach((c, i) => {
    input.push([c, `N${'abcdefghijklmnop'[i]}x`]);
    if (c >= CUT) output.push([c, `N${'abcdefghijklmnop'[i]}x`]);
  });
  return analyzeOk(xlsx(input), xlsx(output));
}

function bandsPair(header: string) {
  const input: V[][] = [[header, 'Name']];
  const output: V[][] = [[header, 'Name', 'Wave']];
  CUSTOMERS.forEach((c, i) => {
    input.push([c, `N${'abcdefghijklmnop'[i]}x`]);
    output.push([c, `N${'abcdefghijklmnop'[i]}x`, c >= CUT ? 'Late' : 'Early']);
  });
  return analyzeOk(xlsx(input), xlsx(output));
}

const sentText = (json: string): boolean => json.includes(String(CUT)) || CUSTOMERS.some((c) => json.includes(String(c)));

describe('a filter cut-off on an identifier column', () => {
  it('masking on: the hint keeps the comparison, not the ID', () => {
    const a = filterPair('Customer No');
    expect(classifyColumns(a).input[0]).toBe('identifier');
    const hint = a.dropped.filters[0];
    expect(hint?.droppedWhen?.op).toMatch(/^(lt|lte)$/);
    expect(CUSTOMERS).toContain(hint?.droppedWhen?.value); // (the real cut-off: an ID of the column)
    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('cut')) });
    const filter = payload.hints.find((h) => h.rel === 'filter') as { droppedWhen?: { op: string; value?: unknown } } | undefined;
    expect(filter?.droppedWhen).toEqual({ op: hint!.droppedWhen!.op });
    expect(sentText(JSON.stringify(payload))).toBe(false);
  });

  it('a measure keeps its cut-off; masking off sends it as before', () => {
    const measure = filterPair('Score');
    expect(classifyColumns(measure).input[0]).toBe('measure');
    const masked = buildPayload(measure, preflight(measure, 'paid'), { masker: createMasker(key('cut')) }).payload;
    expect((masked.hints.find((h) => h.rel === 'filter') as { droppedWhen?: { value?: unknown } }).droppedWhen?.value).toBeOneOf([373817, 373818]);
    const id = filterPair('Customer No');
    const plain = buildPayload(id, preflight(id, 'paid')).payload;
    expect((plain.hints.find((h) => h.rel === 'filter') as { droppedWhen?: { value?: unknown } }).droppedWhen?.value).toBeOneOf([373817, 373818]);
  });
});

describe('bands on an identifier column', () => {
  it('masking on: the bands keep their (masked) values, not the thresholds', () => {
    const a = bandsPair('Customer No');
    const derived = a.columns[2]!.derived;
    expect(derived?.kind).toBe('bands');
    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('bands')) });
    const hint = payload.hints.find((h) => h.rel === 'bands') as { bands: Band[] } | undefined;
    expect(hint?.bands).toHaveLength(2);
    for (const b of hint!.bands) {
      expect(b.lt).toBeUndefined();
      expect(b.gte).toBeUndefined();
    }
    expect(sentText(JSON.stringify(payload))).toBe(false);
  });

  it('bands on a measure keep their thresholds', () => {
    const a = bandsPair('Score');
    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('bands')) });
    const hint = payload.hints.find((h) => h.rel === 'bands') as { bands: Band[] } | undefined;
    expect(hint?.bands.some((b) => b.lt !== undefined || b.gte !== undefined)).toBe(true);
  });
});
