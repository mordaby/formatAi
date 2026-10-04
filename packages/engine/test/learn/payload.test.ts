// buildPayload (SPEC 7.3, LEARN_PROMPT §3): sample selection (including
// failing rows -> failsOn), families mode, dropped rows, size caps and
// truncation, the 48 KB drop order (samples first, then stats), masking of
// cells/hints/target (label words real, everything else consistent with the
// data), and attach mode's `target`.
import { describe, expect, it } from 'vitest';
import type { Format, LearnResult } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { formatOf } from '../../src/registry';
import { analyzePair, type PairAnalysis } from '../../src/learn/analyze';
import { createMasker, type Masker } from '../../src/learn/mask';
import { buildPairPriority, buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { bold, xlsx, type V } from './analyze/helpers';

function key(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

function analyzeOkResult(inHeaders: string[], inRows: V[][], outHeaders: string[], outRows: V[][]): PairAnalysis {
  const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([outHeaders, ...outRows]));
  if (!a.ok) throw new Error(`analysis failed: ${JSON.stringify(a.issues)}`);
  return a;
}

function byteSize(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

// ---------------------------------------------------------------------------
// Basic shape and sample <-> sampleRows correspondence
// ---------------------------------------------------------------------------

describe('buildPayload: basic shape', () => {
  it('builds input/output profiles, samples and hints for a plain pair', () => {
    const inHeaders = ['ID', 'Name'];
    const inRows: V[][] = [];
    for (let i = 0; i < 10; i++) inRows.push([i, `name-${i}`]);
    const outHeaders = ['Name', 'ID'];
    const outRows: V[][] = inRows.map((r) => [r[1]!, r[0]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const { payload, sampleRows } = buildPayload(a, pf);

    expect(payload.masking).toBe(false);
    expect(payload.input.columns.map((c) => c.header)).toEqual(inHeaders);
    expect(payload.output.columns.map((c) => c.header)).toEqual(outHeaders);
    expect(payload.samples.length).toBe(sampleRows.length);
    expect(payload.samples.length).toBeGreaterThan(0);
    expect(payload.hints.length).toBeGreaterThan(0);
    // Every sampleRows entry maps back to a real aligned pair.
    for (const sr of sampleRows) {
      expect(sr.out).toHaveLength(1);
      expect(inRows[sr.in]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Sample selection covers failing rows, and sets failsOn
// ---------------------------------------------------------------------------

describe('buildPayload: sample selection and failsOn', () => {
  it('includes a failing row among the samples and sets failsOn to its index', () => {
    const inHeaders = ['ID', 'Label'];
    const inRows: V[][] = [];
    const outHeaders = ['ID', 'Label'];
    const outRows: V[][] = [];
    const badRows = new Set([7, 15]);
    for (let i = 0; i < 20; i++) {
      inRows.push([i, `label-${i}`]);
      outRows.push([i, badRows.has(i) ? 'WRONG' : `label-${i}`]);
    }
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    // The Label column's copy relation should sit at coverage 18/20 = 0.9.
    const labelCol = a.columns.find((c) => c.header === 'Label')!;
    expect(labelCol.relations[0]).toMatchObject({ rel: 'copy', coverage: 0.9 });

    const pf = preflight(a, 'registered');
    const { payload, sampleRows } = buildPayload(a, pf);

    const labelHint = payload.hints.find((h) => 'out' in h && h.out === labelCol.out)!;
    expect(labelHint).toMatchObject({ coverage: 0.9 });
    expect('failsOn' in labelHint && labelHint.failsOn).toBeTruthy();
    const failsOn = (labelHint as { failsOn: number[] }).failsOn;
    // At least one of the sample indices it points to is a genuinely bad row.
    const pointsAtBadRow = failsOn.some((idx) => badRows.has(sampleRows[idx]!.in));
    expect(pointsAtBadRow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// De-duplication of the first sample (proposal 3.1 follow-up)
// ---------------------------------------------------------------------------

describe('buildPayload: a repeated pair takes one slot', () => {
  const city = ['Haifa', 'Eilat', 'Acre', 'Lod', 'Ramla', 'Yafo', 'Holon', 'Arad', 'Tiberias', 'Dimona'];
  /** Ten rows `[code, qty, city]`, all different, with `same` rows made copies of row 0. */
  function rows(same: number[] = []): V[][] {
    const out: V[][] = city.map((c, i) => [`K${i}`, 10 + i, c]);
    for (const r of same) out[r] = [...out[0]!];
    return out;
  }

  it('two rows with the same input AND output values are sent once; the freed slot goes to the next row', () => {
    const inRows = rows([1]);
    const a = analyzeOkResult(['Code', 'Qty', 'City'], inRows, ['Code', 'Qty', 'City'], inRows);
    expect(a.alignment.rows).toHaveLength(10);
    const caps = { ...limits.payload, maxPairs: 4 };
    const { payload, sampleRows } = buildPayload(a, preflight(a, 'registered'), { caps });
    expect(payload.samples).toHaveLength(4);
    expect(new Set(payload.samples.map((s) => JSON.stringify(s))).size).toBe(4);
    const sent = sampleRows.map((r) => r.in);
    expect(sent).toContain(0);
    expect(sent).not.toContain(1);
    // Without the repeat, the first rows are 0, 1, 2: the slot row 1 would have taken goes to row 3.
    expect(sent.slice(0, 3)).toEqual([0, 2, 3]);
  });

  it('rows with the same input and a different output (a row number) are informative: both are sent', () => {
    const inRows = rows([1]);
    const outRows: V[][] = inRows.map((r, i) => [...r, i + 1]);
    const a = analyzeOkResult(['Code', 'Qty', 'City'], inRows, ['Code', 'Qty', 'City', 'N'], outRows);
    expect(a.alignment.rows).toHaveLength(10);
    const { payload } = buildPayload(a, preflight(a, 'registered'));
    expect(payload.samples).toHaveLength(10);
    expect(payload.samples.filter((s) => s.in[0] === 'K0').map((s) => (s.out as number[])[3]).sort()).toEqual([1, 2]);
  });

  it('compares the real values, before masking and truncation: two cells that differ only past the 40th character are two rows', () => {
    const long = 'y'.repeat(60);
    const inRows = rows();
    inRows[0]![2] = `${long}1`;
    inRows[1] = [...inRows[0]!];
    inRows[1]![2] = `${long}2`;
    const a = analyzeOkResult(['Code', 'Qty', 'City'], inRows, ['Code', 'Qty', 'City'], inRows);
    const { payload, sampleRows } = buildPayload(a, preflight(a, 'registered'), { masker: createMasker(key('dedupe')) });
    expect(payload.samples).toHaveLength(10);
    expect(sampleRows.map((r) => r.in)).toEqual(expect.arrayContaining([0, 1]));
  });

  it('a must-include row (a failing row of a hint) always stays, even when another chosen row holds the same values', () => {
    const inRows = rows([2]);
    const a = analyzeOkResult(['Code', 'Qty', 'City'], inRows, ['Code', 'Qty', 'City'], inRows);
    // Rows 0 and 2 are the same; both are must-include (as two hints' failing rows would make them): both are sent.
    expect(buildPairPriority(a, new Set([0, 2]), 12).slice(0, 2)).toEqual([0, 2]);
    expect(buildPairPriority(a, new Set([0, 2]), 12)).toHaveLength(10);
    // Not must-include: the repeat takes no slot.
    expect(buildPairPriority(a, new Set(), 12)).not.toContain(2);
    expect(buildPairPriority(a, new Set(), 12)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Families mode
// ---------------------------------------------------------------------------

describe('buildPayload: families mode', () => {
  it('sends whole families (in/out[][]), including the smallest and the largest, up to the cap', () => {
    const inHeaders = ['Id', 'A', 'B', 'C'];
    const inRows: V[][] = [];
    const outHeaders = ['Id', 'Label', 'Value'];
    const outRows: V[][] = [];
    // 8 families of varying size (1..3 non-empty cells), so "smallest" and
    // "largest" are meaningfully different.
    for (let i = 0; i < 8; i++) {
      const n = 1 + (i % 3);
      const cells = [10 + i, 20 + i, 30 + i].map((v, j) => (j < n ? v : null));
      inRows.push([i, ...cells]);
      ['A', 'B', 'C'].forEach((label, j) => {
        const v = cells[j]!;
        if (v !== null) outRows.push([i, label, v]);
      });
    }
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    expect(a.shape.kind).toBe('families');
    const pf = preflight(a, 'registered');
    const caps = { ...limits.payload, maxFamilies: 4 };
    const { payload, sampleRows } = buildPayload(a, pf, { caps });

    expect(payload.samples.length).toBeLessThanOrEqual(4);
    for (const s of payload.samples) {
      expect(Array.isArray(s.out[0]) || s.out.length === 0).toBe(true);
    }
    // Families of different sizes are represented (not all the same length).
    const sizes = new Set(sampleRows.map((sr) => sr.out.length));
    expect(sizes.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Dropped rows
// ---------------------------------------------------------------------------

describe('buildPayload: dropped rows', () => {
  it('sends up to the cap of dropped input rows', () => {
    const inHeaders = ['Ref', 'State', 'Amount'];
    const inRows: V[][] = [];
    const outHeaders = ['Ref', 'Amount'];
    const outRows: V[][] = [];
    for (let i = 0; i < 20; i++) {
      const dropped = i % 3 === 0;
      inRows.push([`K${i}`, dropped ? 'cancelled' : 'active', 10 + i]);
      if (!dropped) outRows.push([`K${i}`, 10 + i]);
    }
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    expect(a.dropped.rows.length).toBeGreaterThan(limits.payload.maxDropped);
    const pf = preflight(a, 'registered');
    const { payload } = buildPayload(a, pf);
    expect(payload.dropped).toBeDefined();
    expect(payload.dropped!.length).toBe(limits.payload.maxDropped);
  });
});

// ---------------------------------------------------------------------------
// Caps and truncation
// ---------------------------------------------------------------------------

describe('buildPayload: caps and truncation', () => {
  it('truncates cells to maxCellChars and caps samples at maxPairs', () => {
    const inHeaders = ['ID', 'Text'];
    const inRows: V[][] = [];
    const outHeaders = ['ID', 'Text'];
    const outRows: V[][] = [];
    const longText = 'x'.repeat(80);
    for (let i = 0; i < 20; i++) {
      inRows.push([i, longText]);
      outRows.push([i, longText]);
    }
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const caps = { ...limits.payload, maxCellChars: 5, maxPairs: 3 };
    const { payload } = buildPayload(a, pf, { caps });
    expect(payload.samples.length).toBe(3);
    for (const s of payload.samples) {
      for (const v of [...s.in, ...(s.out as (string | number | boolean | null)[])]) {
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 48 KB size rule: drop samples first (never below minPairs), then stats
// ---------------------------------------------------------------------------

describe('buildPayload: size rules drop samples first, then stats', () => {
  it('drops samples down to minPairs, then stats, when over the byte cap', () => {
    const inHeaders = ['ID', 'Text'];
    const inRows: V[][] = [];
    const outHeaders = ['ID', 'Text'];
    const outRows: V[][] = [];
    for (let i = 0; i < 12; i++) {
      inRows.push([i, `value-${i}-${'y'.repeat(20)}`]);
      outRows.push([i, `value-${i}-${'y'.repeat(20)}`]);
    }
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');

    const roomyCaps = { ...limits.payload };
    const roomy = buildPayload(a, pf, { caps: roomyCaps });
    const fullSampleCount = roomy.payload.samples.length;
    expect(fullSampleCount).toBeGreaterThan(limits.payload.minPairs);

    // A byte budget too small for the full sample set, but big enough to
    // settle above minPairs.
    const tightCaps = { ...limits.payload, maxBytes: byteSize(roomy.payload) - 200, minPairs: 4 };
    const tight = buildPayload(a, pf, { caps: tightCaps });
    expect(tight.payload.samples.length).toBeLessThan(fullSampleCount);
    expect(tight.payload.samples.length).toBeGreaterThanOrEqual(tightCaps.minPairs);

    // A budget so small even minPairs samples don't fit: stats get dropped too.
    const tinyCaps = { ...limits.payload, maxBytes: 40, minPairs: 4 };
    const tiny = buildPayload(a, pf, { caps: tinyCaps });
    expect(tiny.payload.samples.length).toBe(tinyCaps.minPairs);
    expect(tiny.payload.input.columns.every((c) => c.stats === undefined)).toBe(true);
    expect(tiny.payload.output.columns.every((c) => c.stats === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe('buildPayload: masking', () => {
  function buildMaskedCase(masker: Masker) {
    const inHeaders = ['Id', 'Customer', 'Status'];
    const inRows: V[][] = [
      [1, 'Dana Cohen', 'active'],
      [2, 'Yossi Levi', 'closed'],
      [3, 'Dana Cohen', 'active'],
      [4, 'Noa Bar', 'closed'],
      [5, 'Yossi Levi', 'active'],
    ];
    const outHeaders = ['Id', 'Name', 'Status'];
    const outRows: V[][] = inRows.map((r) => [r[0]!, r[1]!, r[2] === 'active' ? 'A' : 'C']);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    return buildPayload(a, pf, { masker });
  }

  it('masks data words consistently, and never leaks a real masked word or the key into the payload', () => {
    const realKey = key('session-secret');
    const masker = createMasker(realKey);
    const { payload } = buildMaskedCase(masker);
    expect(payload.masking).toBe(true);

    const json = JSON.stringify(payload);
    // The real customer names never appear verbatim.
    expect(json).not.toContain('Dana');
    expect(json).not.toContain('Cohen');
    expect(json).not.toContain('Yossi');
    // Nor does the key itself, in any encoding a naive leak might use.
    expect(json).not.toContain(Buffer.from(realKey).toString('utf-8'));
    expect(json).not.toContain(Buffer.from(realKey).toString('hex'));
    expect(json).not.toContain(Buffer.from(realKey).toString('base64'));

    // The masking is consistent: the same real word produces the same fake
    // wherever it appears in the samples.
    const fakeDana = masker.maskText('Dana');
    const occurrences = payload.samples.flatMap((s) => [...s.in, ...(Array.isArray(s.out[0]) ? (s.out as unknown[][]).flat() : s.out)]);
    const fakeCells = occurrences.filter((v): v is string => typeof v === 'string' && v.includes(fakeDana));
    expect(fakeCells.length).toBeGreaterThan(0);
  });

  it('masks valueMap hint pairs and filter values, not just samples', () => {
    const inHeaders = ['Id', 'Status'];
    // Values whose mapping isn't also explainable as a substr/prefix (so the
    // pair analysis's best relation is genuinely valueMap, not something simpler).
    const inRows: V[][] = [
      [1, 'Aleph'],
      [2, 'Bet'],
      [3, 'Aleph'],
      [4, 'Bet'],
      [5, 'Aleph'],
    ];
    const outHeaders = ['Id', 'Code'];
    const outRows: V[][] = inRows.map((r) => [r[0]!, r[1] === 'Aleph' ? 'X1' : 'Y2']);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'valueMap' });
    const pf = preflight(a, 'registered');
    const masker = createMasker(key('vm-session'));
    const { payload } = buildPayload(a, pf, { masker });
    const vm = payload.hints.find((h) => h.rel === 'valueMap');
    expect(vm).toBeDefined();
    const json = JSON.stringify(payload);
    expect(json).not.toContain('Aleph');
    expect(json).not.toContain('Bet');
  });

  it('sends a label word (a title that never appears in any data cell) real', () => {
    const inHeaders = ['Id', 'Name'];
    const inRows: V[][] = [];
    for (let i = 0; i < 8; i++) inRows.push([i, `person-${i}`]);
    const outRows = inRows.map((r) => [...r]);
    const outputWb = xlsx([[bold('Monthly Report')], ['Id', 'Name'], ...outRows]);
    const a = analyzePair(xlsx([inHeaders, ...inRows]), outputWb);
    if (!a.ok) throw new Error('analysis failed');
    const pf = preflight(a, 'registered');
    const masker = createMasker(key('label-session'));
    const { payload } = buildPayload(a, pf, { masker });
    const title = payload.output.layout.titleRows.find((t) => t.text !== undefined);
    expect(title?.text).toBe('Monthly Report');
  });

  it('judges a label word on EVERY data row (SPEC 7.2), not only the rows the payload samples: a title word that sits in an unsampled row is masked', () => {
    const inHeaders = ['Id', 'Name'];
    const build = (word: string | null, at: number): { a: PairAnalysis; inRows: V[][] } => {
      const inRows: V[][] = [];
      for (let i = 0; i < 300; i++) inRows.push([i, i === at && word ? word : `person-${i}`]);
      const a = analyzePair(xlsx([inHeaders, ...inRows]), xlsx([[bold('Zebulon Report')], ['Id', 'Name'], ...inRows.map((r) => [...r])]));
      if (!a.ok) throw new Error('analysis failed');
      return { a, inRows };
    };
    // a row the payload does not sample (the samples are a handful of the 300)
    const probe = build(null, -1);
    const sampled = new Set(buildPayload(probe.a, preflight(probe.a, 'registered')).sampleRows.map((s) => s.in));
    const at = [150, 151, 152, 153, 154].find((i) => !sampled.has(i));
    expect(at).toBeDefined();
    const { a } = build('Zebulon', at!);
    const pf = preflight(a, 'registered');
    const masker = createMasker(key('label-every-row'));
    const built = buildPayload(a, pf, { masker });
    expect(built.sampleRows.some((s) => s.in === at)).toBe(false); // the row with the word is not among the samples
    const { payload } = built;
    const title = payload.output.layout.titleRows.find((t) => t.text !== undefined);
    expect(title?.text).not.toContain('Zebulon'); // ... yet its word is a data word: masked in the title
    expect(title?.text).toContain('Report'); // a label word stays real
  });
});

// ---------------------------------------------------------------------------
// Attach mode
// ---------------------------------------------------------------------------

describe('buildPayload: attach mode', () => {
  function sampleFormat(): Format {
    const rules: LearnResult = {
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'id', header: 'ID', type: 'integer' }] },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [{ text: 'Sales Report' }],
        columns: [{ header: 'Client Name', from: 'id' }],
        headerStyle: { bold: true },
      },
      validations: [{ on: 'output', column: 'Client Name', rule: 'required', severity: 'flag' }],
      unsupported: [],
      assumptions: [],
    };
    return formatOf(rules);
  }

  it('includes target when given, and masks its header/title words that also appear in data', () => {
    const inHeaders = ['Id', 'Client Name'];
    const inRows: V[][] = [
      [1, 'Client Name'], // deliberately reuses the header text as a data value
      [2, 'Someone Else'],
    ];
    const outHeaders = ['Client Name'];
    const outRows: V[][] = inRows.map((r) => [r[1]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const target = sampleFormat();
    const masker = createMasker(key('attach-session'));
    const { payload } = buildPayload(a, pf, { masker, target });

    expect(payload.target).toBeDefined();
    expect(payload.target!.output.titleRows).toEqual(target.output.titleRows); // "Client Report" is a pure label: sent real
    // "Client Name" also appears as a data cell, so target's header for it is masked.
    expect(payload.target!.output.columns[0]!.header).not.toBe('Client Name');
  });

  it('without a masker, target is sent through unmasked', () => {
    const inHeaders = ['Id', 'Name'];
    const inRows: V[][] = [
      [1, 'A'],
      [2, 'B'],
    ];
    const outHeaders = ['Name'];
    const outRows: V[][] = inRows.map((r) => [r[1]!]);
    const a = analyzeOkResult(inHeaders, inRows, outHeaders, outRows);
    const pf = preflight(a, 'registered');
    const target = sampleFormat();
    const { payload } = buildPayload(a, pf, { target });
    expect(payload.target).toEqual({ output: target.output, layout: target.layout, validations: target.outputValidations });
  });
});
