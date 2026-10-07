// API audit P1 (2026-10-07): the server's sample run compares cells the way the browser's full verification does (engine `cellsMatch`).
// The case: supplier-pricelist-erp-load writes a tab-separated txt file, so every cell of the example output is text - the price "407.03"
// - while the reference rules make the number 407.03 (a decimal column). The strict compare (`actual.v === expected`) called every price
// a `diff`, with masking on and off alike, so the correct rules failed the server's checks; now they pass both, as they pass the browser's.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOnSamples } from '@formatai/api/learn';
import { analyzePair, buildPayload, createMasker, preflight, readWorkbook, sniffDelimitedText, verifyAgainstExample, type PairAnalysis } from '@formatai/engine';
import type { PayloadCell } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');

async function analysisOf(c: CaseDef): Promise<PairAnalysis> {
  const input = await readWorkbook(c.input.bytes, c.input.fileName);
  const output = await readWorkbook(c.output.bytes, c.output.fileName);
  const sniff = output.fileType === 'csv' || output.fileType === 'txt' ? sniffDelimitedText(c.output.bytes) : undefined;
  const a = analyzePair(input, output, sniff ? { outputSniff: sniff } : {});
  if (!a.ok) throw new Error(`${c.name}: the analysis failed`);
  return a;
}

describe('supplier-pricelist-erp-load: the reference rules pass the server sample run, as they pass the browser', () => {
  for (const masking of [false, true]) {
    it(`masking ${masking ? 'on' : 'off'}`, async () => {
      const c = loadCase(path.join(CASES, 'supplier-pricelist-erp-load'))!;
      const a = await analysisOf(c);
      const pf = preflight(a, 'paid');
      const payload = buildPayload(a, pf, masking ? { masker: createMasker(new TextEncoder().encode('sample-run-typed')) } : {}).payload;
      // The case as the audit found it: a delimited output whose prices are text in the samples.
      expect(payload.output.file.type).toBe('txt');
      const prices = payload.samples.map((s) => (s.out as PayloadCell[])[2]);
      expect(prices.every((v) => typeof v === 'string' && /^\d+\.\d+$/.test(v))).toBe(true);

      expect(verifyAgainstExample(c.referenceRules!, a).verified).toBe(true);
      expect(runOnSamples(c.referenceRules!, payload)).toEqual([]);
    });
  }
});
