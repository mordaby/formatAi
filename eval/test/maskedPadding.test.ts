// Masking (SPEC 7.2, amendment 2026-10-06): leading zeros survive masking. Walked over the five cases whose ID-like input column holds
// numbers and whose output writes it as zero-padded text. Before, each value got an unrelated fake (12345 -> 83920, "000012345" ->
// "571046293"), so the padding was invisible in the masked samples and the reference rules failed the server's sample run on them. Now
// the masked output is the masked input padded with zeros, and masking adds no problem to the sample run. Also: the path each case takes
// with no AI step (amendment: numeric IDs on the free path).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOnSamples } from '@formatai/api/learn';
import { analyzePair, buildPayload, createMasker, fastPath, learnFromExamples, preflight, readWorkbook, sniffDelimitedText, type PairAnalysis } from '@formatai/engine';
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

/** The output columns the analysis explains as an input column padded with zeros. */
function paddedColumns(a: PairAnalysis): { out: number; in: number; length: number }[] {
  return a.columns.flatMap((ca) => {
    const r = ca.relations[0];
    return r?.rel === 'padLeft' && r.char === '0' && r.coverage === 1 ? [{ out: ca.out, in: r.in[0], length: r.length }] : [];
  });
}

const FREE_PATH = new Set(['messy-layout-he', 'supplier-pricelist-erp-load']);

describe('masked samples show the zero padding of an ID stored as a number', () => {
  for (const name of ['messy-layout-he', 'registry-supplier-a', 'registry-supplier-c', 'stock-count-warehouse-report', 'supplier-pricelist-erp-load']) {
    it(`${name}: each masked output is its masked input padded; the reference rules pass the sample run as they do unmasked`, async () => {
      const c = loadCase(path.join(CASES, name))!;
      const a = await analysisOf(c);
      const pf = preflight(a, 'paid');
      const padded = paddedColumns(a);
      expect(padded.length).toBeGreaterThan(0);

      const masked = buildPayload(a, pf, { masker: createMasker(new TextEncoder().encode(`padding:${name}`)) }).payload;
      for (const s of masked.samples) {
        for (const p of padded) {
          const fakeIn = s.in[p.in];
          expect(typeof fakeIn).toBe('number');
          expect((s.out as PayloadCell[])[p.out]).toBe(String(fakeIn).padStart(p.length, '0'));
        }
      }

      // The server's sample run with the case's reference rules: masking adds no problem, and none names a padded column. (With
      // masking off supplier-pricelist-erp-load's price cells - text in its txt output - differ from the number the rules make, the
      // same with masking on: not a masking matter.)
      const plain = runOnSamples(c.referenceRules!, buildPayload(a, pf).payload);
      const problems = runOnSamples(c.referenceRules!, masked);
      expect(problems.length).toBe(plain.length);
      for (const p of problems) if (p.kind === 'diff') expect(padded.map((x) => x.out)).not.toContain(p.out);
    });
  }
});

describe('the path each of the five takes with no AI step', () => {
  for (const name of ['messy-layout-he', 'registry-supplier-a', 'registry-supplier-c', 'stock-count-warehouse-report', 'supplier-pricelist-erp-load']) {
    it(`${name}: ${FREE_PATH.has(name) ? 'the fast path, verified' : 'the AI step, for its layout (not for its IDs)'}`, async () => {
      const c = loadCase(path.join(CASES, name))!;
      if (FREE_PATH.has(name)) {
        const r = await learnFromExamples({
          input: { bytes: c.input.bytes, name: c.input.fileName },
          output: { bytes: c.output.bytes, name: c.output.fileName },
          masking: true,
          key: new TextEncoder().encode(`free:${name}`),
          tier: 'paid',
          callLearn: async () => {
            throw new Error('the AI step was asked');
          },
        });
        expect(r.path).toBe('local');
        expect(r.verification?.verified).toBe(true);
        return;
      }
      const a = await analysisOf(c);
      const fp = fastPath(a, preflight(a, 'paid'));
      expect('reason' in fp ? fp.reason : 'built').toBe('layoutUnsupported');
    });
  }
});
