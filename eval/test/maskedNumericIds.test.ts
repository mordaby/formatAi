// Masking (SPEC 7.2, amendment 2026-10-06): identifiers stored as numbers are masked. Walked over the cases whose ID-like input column
// holds numbers (an ID, a SKU typed as a number in Excel): with masking off the payload carries them as they are; with masking on not one
// of them is in the request, and each is a number again, of the same length, so a copy or a type still reads the same.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzePair, buildPayload, createMasker, preflight, readWorkbook, sniffDelimitedText, type PairAnalysis } from '@formatai/engine';
import type { LearnPayload, PayloadCell } from '@formatai/shared';
import { loadCase } from '../lib/caseLoader';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');

async function analysisOf(name: string): Promise<PairAnalysis> {
  const c = loadCase(path.join(CASES, name))!;
  const input = await readWorkbook(c.input.bytes, c.input.fileName);
  const output = await readWorkbook(c.output.bytes, c.output.fileName);
  const outputSniff = output.fileType === 'csv' || output.fileType === 'txt' ? sniffDelimitedText(c.output.bytes) : undefined;
  const a = analyzePair(input, output, outputSniff ? { outputSniff } : {});
  if (!a.ok) throw new Error(`${name}: analysis failed`);
  return a;
}

function inputColumn(payload: LearnPayload, column: number): PayloadCell[] {
  return payload.samples.map((s) => s.in[column] ?? null);
}

describe('masking replaces ID numbers stored as numbers', () => {
  for (const [name, header] of [
    ['messy-layout-he', /ת\.ז\./],
    ['stock-count-warehouse-report', /מקט/],
  ] as const) {
    it(`${name}: the numeric ${String(header)} column is sent real with masking off, masked as numbers with masking on`, async () => {
      const a = await analysisOf(name);
      const column = a.input.profile.findIndex((p) => header.test(p.header));
      expect(a.input.profile[column]?.type).toBe('idLike');
      const pf = preflight(a, 'paid');
      const reals = inputColumn(buildPayload(a, pf).payload, column);
      const numbers = reals.filter((v): v is number => typeof v === 'number');
      expect(numbers.length).toBeGreaterThan(0);

      const masked = buildPayload(a, pf, { masker: createMasker(new TextEncoder().encode(`numeric-ids:${name}`)) }).payload;
      // no real value is sent as a cell (an ID of 5+ digits is not anywhere in the request either; a short one may sit inside another number)
      const cells = new Set(masked.samples.flatMap((s) => [...s.in, ...(s.out as PayloadCell[])]).map((v) => String(v)));
      for (const real of numbers) expect(cells.has(String(real))).toBe(false);
      const json = JSON.stringify(masked);
      for (const real of numbers) if (String(real).length >= 5) expect(json).not.toContain(String(real));
      // the same rows in the same order: each fake is a number of its real value's length
      inputColumn(masked, column).forEach((fake, i) => {
        const real = reals[i];
        if (typeof real !== 'number') return;
        expect(typeof fake).toBe('number');
        expect(String(fake)).toHaveLength(String(real).length);
      });
    });
  }
});
