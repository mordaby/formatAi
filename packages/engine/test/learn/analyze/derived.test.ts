// Derived columns (SPEC 6.2 step 4, SPEC 21 v5 item 4): an output column no relation explains is `unknown`; it is
// EXTERNAL data only when the input doesn't determine it. When the input does (bands on a number or a date, a
// category dependency on repeated values of one or two columns), the column is DERIVED: the AI can solve it, so
// pre-flight doesn't skip it, the readiness gate doesn't finish "locally", and the partial result lists it as
// "needs the AI step". Synthetic, domain-neutral data.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../../src/io/read';
import { sniffDelimitedText } from '../../../src/io/detectFileSpec';
import { analyzePair, isDerivedColumn, isExternalColumn, type PairAnalysis } from '../../../src/learn/analyze';
import { fastPath } from '../../../src/learn/fastPath';
import { learnFromExamples, type LearnCallResult } from '../../../src/learn/flow';
import { relationsToHints } from '../../../src/learn/hints';
import { createMasker } from '../../../src/learn/mask';
import { partialRules } from '../../../src/learn/partial';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { aiReadiness } from '../../../src/learn/readiness';
import { analyzeOk, rng, serial, xlsx, type V } from './helpers';
import { xlsxBytesOf, type Pair } from '../v5fixtures';

const WORDS = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lantern'];

/** A permutation of 1..30 (no repeated Qty, so no value map applies to it, and 9 | 10 are neighbours). */
const PERM30 = Array.from({ length: 30 }, (_, i) => ((i * 11) % 30) + 1);

/** Ref / Item / Qty in, Ref / Item / Size out, where Size is a rule on Qty (default: bulk from 10). */
function sizePair(qtys: readonly number[], sizeOf: (q: number, i: number) => V = (q) => (q >= 10 ? 'bulk' : 'single')): Pair {
  const input: V[][] = [['Ref', 'Item', 'Qty']];
  const output: V[][] = [['Ref', 'Item', 'Size']];
  qtys.forEach((q, i) => {
    const ref = `R-${1000 + i * 7}`;
    const item = `${WORDS[i % WORDS.length]} ${i}`;
    input.push([ref, item, q]);
    output.push([ref, item, sizeOf(q, i)]);
  });
  return { input, output };
}

function analyze(pair: Pair): PairAnalysis {
  return analyzeOk(xlsx(pair.input), xlsx(pair.output));
}

function column(a: PairAnalysis, header: string) {
  const ca = a.columns.find((c) => c.header === header);
  if (!ca) throw new Error(`no column ${header}`);
  return ca;
}

describe('bands on a number: Size = "bulk" if Qty >= 10 else "single"', () => {
  const a = analyze(sizePair(PERM30));
  const size = column(a, 'Size');

  it('is unknown (no relation), but derived - not external', () => {
    expect(size.unknown).toBe(true);
    expect(size.relations).toEqual([]);
    expect(isDerivedColumn(size)).toBe(true);
    expect(isExternalColumn(size)).toBe(false);
  });

  it('reports the breakpoint and the determining column', () => {
    expect(size.derived).toMatchObject({ kind: 'bands', in: [2], coverage: 1, failCount: 0, failing: [] });
    expect(size.derived).toMatchObject({ bands: [{ lt: 10, value: 'single' }, { gte: 10, value: 'bulk' }] });
  });

  it('the columns the code explains stay explained', () => {
    expect(a.columns.filter((c) => !c.unknown).map((c) => c.header)).toEqual(['Ref', 'Item']);
  });

  it('a breakpoint between two seen values is reported as the roundest number in the gap (9 | 12 -> 10)', () => {
    const qty = [3, 12, 7, 25, 1, 40, 9, 15, 2, 30];
    const b = analyze(sizePair(qty));
    expect(column(b, 'Size').derived).toMatchObject({ kind: 'bands', bands: [{ lt: 10, value: 'single' }, { gte: 10, value: 'bulk' }] });
  });

  it('three bands with numeric values (discount by amount), thresholds rounded inside the gaps', () => {
    const amounts = [40, 55, 70, 85, 130, 160, 210, 250, 300, 340, 390, 430, 470, 640, 700, 760, 820, 900, 950, 980];
    const shuffled = amounts.map((_, i) => amounts[(i * 7) % amounts.length]!);
    const pair = sizePair(shuffled, (q) => (q < 100 ? 0 : q < 500 ? 0.05 : 0.1));
    pair.input[0]![2] = 'Amount';
    pair.output[0]![2] = 'Discount';
    const c = column(analyze(pair), 'Discount');
    expect(c.derived).toMatchObject({
      kind: 'bands',
      in: [2],
      bands: [
        { lt: 100, value: 0 },
        { gte: 100, lt: 500, value: 0.05 },
        { gte: 500, value: 0.1 },
      ],
    });
  });

  it('one hand-edited row inside a band is an exception (coverage < 1), not a new band', () => {
    const pair = sizePair(PERM30, (q) => (q === 5 ? 'special' : q >= 10 ? 'bulk' : 'single'));
    const c = column(analyze(pair), 'Size');
    expect(c.derived).toMatchObject({ kind: 'bands', bands: [{ lt: 10, value: 'single' }, { gte: 10, value: 'bulk' }], failCount: 1 });
    expect(c.derived!.coverage).toBeCloseTo(29 / 30, 10);
    expect(c.derived!.failing).toHaveLength(1);
  });

  it('too many breakpoints (> 5) is not a band rule: the values just alternate', () => {
    const pair = sizePair(PERM30, (q) => (Math.floor((q - 1) / 3) % 2 === 0 ? 'A' : 'B'));
    const c = column(analyze(pair), 'Size');
    expect(c.unknown).toBe(true);
    expect(c.derived).toBeNull();
  });

  it('a value seen on a single row is an exception, not a band; two rows make a band', () => {
    // "huge" on one row (Qty 30), "tiny" on one row (Qty 1): exceptions of the two real bands.
    const one = column(analyze(sizePair(PERM30, (q) => (q === 30 ? 'huge' : q === 1 ? 'tiny' : q >= 10 ? 'bulk' : 'single'))), 'Size');
    expect(one.derived).toMatchObject({ kind: 'bands', bands: [{ lt: 10, value: 'single' }, { gte: 10, value: 'bulk' }], failCount: 2 });
    // "huge" on two rows (Qty 29, 30) is a third band.
    const two = column(analyze(sizePair(PERM30, (q) => (q >= 29 ? 'huge' : q >= 10 ? 'bulk' : 'single'))), 'Size');
    expect(two.derived).toMatchObject({ kind: 'bands', bands: [{ lt: 10, value: 'single' }, { gte: 10, lt: 29, value: 'bulk' }, { gte: 29, value: 'huge' }], failCount: 0 });
  });

  it('too many exceptions (coverage below 0.9) is no rule: the column stays external', () => {
    const odd = new Set([3, 6, 15, 20, 25]);
    const c = column(analyze(sizePair(PERM30, (q) => (odd.has(q) ? 'x' : q >= 10 ? 'bulk' : 'single'))), 'Size');
    expect(c.unknown).toBe(true);
    expect(c.derived).toBeNull();
  });
});

describe('bands on a date', () => {
  it('reports ISO date breakpoints', () => {
    const day = (off: number) => ({ v: serial(2024, 1, 1) + off, isDate: true, z: 'dd/mm/yyyy' });
    // winter up to Feb 21, summer Mar 11 - Aug 23 (offset 235), autumn from Sep 17 (offset 260)
    const offsets = [4, 10, 17, 23, 30, 38, 45, 51, 70, 80, 95, 110, 120, 140, 160, 175, 200, 235, 260, 270, 290, 300, 310, 330, 340];
    const spread = offsets.map((_, i) => offsets[(i * 7) % offsets.length]!);
    const season = (off: number) => (off < 60 ? 'winter' : off < 244 ? 'summer' : 'autumn');
    const input: V[][] = [['Ref', 'Day']];
    const output: V[][] = [['Ref', 'Season']];
    spread.forEach((off, i) => {
      input.push([`R-${100 + i * 3}`, day(off)]);
      output.push([`R-${100 + i * 3}`, season(off)]);
    });
    const c = column(analyze({ input, output }), 'Season');
    expect(c.derived).toMatchObject({
      kind: 'bands',
      in: [1],
      bands: [{ lt: '2024-03-01', value: 'winter' }, { gte: '2024-03-01', lt: '2024-09-01', value: 'summer' }, { gte: '2024-09-01', value: 'autumn' }],
    });
  });
});

describe('category dependency', () => {
  it('on one column, with more than 50 distinct keys (a value map stops at 50)', () => {
    const MANAGERS = ['Ari', 'Bea', 'Cal', 'Dov', 'Eli'];
    const input: V[][] = [['Ref', 'Account', 'Note']];
    const output: V[][] = [['Ref', 'Account', 'Manager']];
    for (let i = 0; i < 120; i++) {
      const acct = i % 70; // 70 accounts; the first 50 appear twice
      const ref = `R-${2000 + i * 3}`;
      input.push([ref, `A-${5000 + acct * 13}`, `n${i}`]);
      output.push([ref, `A-${5000 + acct * 13}`, MANAGERS[(acct * 3) % 5]!]);
    }
    const a = analyze({ input, output });
    const c = column(a, 'Manager');
    expect(c.relations).toEqual([]);
    expect(c.derived).toMatchObject({ kind: 'category', in: [1], keys: 70, coverage: 1 });
    expect(isExternalColumn(c)).toBe(false);
    const hint = relationsToHints(a, preflight(a, 'paid')).find((h) => 'out' in h && h.out === 2);
    expect(hint).toEqual({ rel: 'dependsOn', in: [1], out: 2, coverage: 1 });
  });

  it('on two columns together (neither alone determines it)', () => {
    const TIERS = ['Gold', 'Silver', 'Bronze', 'Iron'];
    const REGIONS = ['North', 'South', 'East'];
    const KINDS = ['pump', 'valve', 'gauge', 'filter'];
    const input: V[][] = [['Ref', 'Region', 'Kind']];
    const output: V[][] = [['Ref', 'Region', 'Tier']];
    for (let i = 0; i < 48; i++) {
      const r = i % 3;
      const k = Math.floor(i / 3) % 4;
      const ref = `R-${300 + i * 5}`;
      input.push([ref, REGIONS[r]!, KINDS[k]!]);
      output.push([ref, REGIONS[r]!, TIERS[(2 * r + k) % 4]!]);
    }
    const c = column(analyze({ input, output }), 'Tier');
    expect(c.relations).toEqual([]);
    expect(c.derived).toMatchObject({ kind: 'category', in: [1, 2], keys: 12, coverage: 1 });
  });
});

describe('external columns stay external', () => {
  it('a column assigned from somewhere else: no dependency on any column or pair of columns', () => {
    const r = rng(21);
    const GROUPS = ['North', 'South', 'East'];
    const KINDS = ['pump', 'valve', 'gauge', 'filter'];
    const input: V[][] = [['Ref', 'Group', 'Kind', 'Qty']];
    const output: V[][] = [['Ref', 'Group', 'Dock']];
    for (let i = 0; i < 48; i++) {
      const ref = `R-${400 + i * 5}`;
      input.push([ref, GROUPS[i % 3]!, KINDS[(i * 5) % 4]!, 1 + ((i * 7) % 48)]);
      output.push([ref, GROUPS[i % 3]!, `D${1 + Math.floor(r() * 3)}`]);
    }
    const c = column(analyze({ input, output }), 'Dock');
    expect(c.unknown).toBe(true);
    expect(c.derived).toBeNull();
    expect(isExternalColumn(c)).toBe(true);
  });

  it('a dependency on an almost-unique key is memorizing, not a rule', () => {
    const input: V[][] = [['Ref', 'Batch']];
    const output: V[][] = [['Ref', 'Bin']];
    for (let i = 0; i < 20; i++) {
      const batch = `B-${9000 + (i === 19 ? 3 : i) * 17}`; // 19 batches over 20 rows: one repeat
      input.push([`R-${500 + i * 9}`, batch]);
      output.push([`R-${500 + i * 9}`, `BIN-${(i === 19 ? 3 : i) * 31 + 7}`]);
    }
    const c = column(analyze({ input, output }), 'Bin');
    expect(c.unknown).toBe(true);
    expect(c.derived).toBeNull();
  });

  it('the eval case fulfillment-external-column keeps its external column', async () => {
    const dir = path.resolve(__dirname, '../../../../../eval/cases/fulfillment-external-column');
    const find = (base: string): string => fs.readdirSync(dir).find((e) => e.startsWith(`${base}.`))!;
    const inName = find('input');
    const outName = find('output');
    const inBytes = new Uint8Array(fs.readFileSync(path.join(dir, inName)));
    const outBytes = new Uint8Array(fs.readFileSync(path.join(dir, outName)));
    const outWb = await readWorkbook(outBytes, outName);
    const sniff = outWb.fileType === 'csv' || outWb.fileType === 'txt' ? sniffDelimitedText(outBytes) : undefined;
    const a = analyzePair(await readWorkbook(inBytes, inName), outWb, sniff ? { outputSniff: sniff } : {});
    if (!a.ok) throw new Error('analysis failed');
    const unknown = a.columns.filter((c) => c.unknown);
    expect(unknown.map((c) => c.header)).toEqual(['Assigned Warehouse']);
    expect(unknown.every(isExternalColumn)).toBe(true);
    // (classified external internally - but never skipped: the AI step still tries it)
    expect(preflight(a, 'paid').skipColumns).toEqual([]);
  });
});

// A pair with a derived column (Size), an external one (Dock) and copies.
function derivedAndExternal(): Pair {
  const { input, output } = sizePair(PERM30);
  const r = rng(5);
  return { input, output: output.map((row, i) => [...row, i === 0 ? 'Dock' : `D${100 + Math.floor(r() * 800)}`]) };
}

describe('pre-flight: external columns are only noted, never skipped', () => {
  it('a derived column is not in skipColumns and does not raise the "unknown columns" note', () => {
    const a = analyze(sizePair(PERM30));
    const pf = preflight(a, 'paid');
    expect(pf.skipColumns).toEqual([]);
    expect(pf.issues).toEqual([]);
    expect(pf.status).toBe('ok');
  });

  it('with an external column too, only that one is noted and counted (informational, nothing skipped)', () => {
    const a = analyze(derivedAndExternal());
    const pf = preflight(a, 'paid');
    expect(pf.skipColumns).toEqual([]);
    expect(pf.status).toBe('ok');
    expect(pf.issues).toContainEqual({ code: 'unknownOutputColumns', severity: 'info', params: { count: 1 } });
  });
});

describe('the strict fast path does not solve a derived column', () => {
  it('reports the column as not fully explained (it goes to the AI)', () => {
    const a = analyze(sizePair(PERM30));
    expect(fastPath(a, preflight(a, 'paid'))).toMatchObject({ reason: 'columnNotFullyExplained' });
  });
});

describe('hints', () => {
  it('a bands hint, with the breakpoints and the coverage', () => {
    const a = analyze(sizePair(PERM30));
    const hints = relationsToHints(a, preflight(a, 'paid'));
    expect(hints.find((h) => 'out' in h && h.out === 2)).toEqual({
      rel: 'bands',
      in: [2],
      out: 2,
      coverage: 1,
      bands: [
        { lt: 10, value: 'single' },
        { gte: 10, value: 'bulk' },
      ],
    });
  });

  it('an external column still has no hint, and is NOT sent as skipColumns (the AI step gets it as a normal output column)', () => {
    const a = analyze(derivedAndExternal());
    const pf = preflight(a, 'paid');
    expect(relationsToHints(a, pf).find((h) => 'out' in h && h.out === 3)).toBeUndefined();
    expect(buildPayload(a, pf).payload.skipColumns).toBeUndefined();
  });

  it('with an exception row, the hint says where it fails (failsOn points at a sample)', () => {
    const a = analyze(sizePair(PERM30, (q) => (q === 5 ? 'special' : q >= 10 ? 'bulk' : 'single')));
    const { payload } = buildPayload(a, preflight(a, 'paid'));
    const hint = payload.hints.find((h) => 'out' in h && h.out === 2)!;
    expect(hint).toMatchObject({ rel: 'bands' });
    expect(hint.coverage).toBeCloseTo(29 / 30, 10);
    expect(hint.failsOn).toHaveLength(1);
    expect(payload.samples[hint.failsOn![0]!]!.out).toEqual([expect.any(String), expect.any(String), 'special']);
  });
});

describe('masking: band values are masked like other hint values', () => {
  const a = analyze(sizePair(PERM30));
  const pf = preflight(a, 'paid');

  it('off: the real values', () => {
    const { payload } = buildPayload(a, pf);
    expect(JSON.stringify(payload.hints)).toContain('"bulk"');
  });

  it('on: the band values are the same fake words the samples use; the thresholds stay real', () => {
    const masker = createMasker(new TextEncoder().encode('derived-test-key'));
    const { payload } = buildPayload(a, pf, { masker });
    const hint = payload.hints.find((h) => 'out' in h && h.out === 2);
    if (!hint || hint.rel !== 'bands') throw new Error('no bands hint');
    const [low, high] = hint.bands;
    expect(low).toMatchObject({ lt: 10 });
    expect(high).toMatchObject({ gte: 10 });
    expect(JSON.stringify(payload)).not.toMatch(/bulk|single/);
    // The samples carry the same fake words for the same rows.
    const seen = new Map<number, string>();
    for (const s of payload.samples) seen.set(s.in[2] as number, (s.out as unknown[])[2] as string);
    const lowQty = [...seen.keys()].find((q) => q < 10)!;
    const highQty = [...seen.keys()].find((q) => q >= 10)!;
    expect(seen.get(lowQty)).toBe(low!.value);
    expect(seen.get(highQty)).toBe(high!.value);
    expect(low!.value).not.toBe(high!.value);
  });

  it('numeric band values are not masked', () => {
    const amounts = [40, 55, 70, 85, 130, 160, 210, 250, 300, 340, 390, 430, 470, 640, 700, 760, 820, 900, 950, 980];
    const shuffled = amounts.map((_, i) => amounts[(i * 7) % amounts.length]!);
    const pair = sizePair(shuffled, (q) => (q < 100 ? 0 : 0.05));
    const b = analyze(pair);
    const masker = createMasker(new TextEncoder().encode('derived-test-key'));
    const { payload } = buildPayload(b, preflight(b, 'paid'), { masker });
    const hint = payload.hints.find((h) => 'out' in h && h.out === 2);
    expect(hint).toMatchObject({ rel: 'bands', bands: [{ lt: 100, value: 0 }, { gte: 100, value: 0.05 }] });
  });
});

describe('partial result and the readiness gate', () => {
  it('both the derived and the external column "need the AI step"; only the external one is marked external (wording)', () => {
    const a = analyze(derivedAndExternal());
    const p = partialRules(a, preflight(a, 'paid'));
    if ('reason' in p) throw new Error('unreachable');
    expect(p.solved).toEqual(['Ref', 'Item']);
    expect(p.needsAi).toEqual(['Size', 'Dock']);
    expect(p.external).toEqual(['Dock']);
    expect(p.rules.unsupported).toEqual([]);
  });

  it('a derived column alone: the gate lets the AI step run (it is not "only external columns left")', () => {
    const a = analyze(sizePair(PERM30));
    const r = aiReadiness(a, preflight(a, 'paid'));
    expect(r.ready).toBe(true);
  });

  it('derived + external, or external alone: the AI step runs either way', () => {
    const a = analyze(derivedAndExternal());
    expect(aiReadiness(a, preflight(a, 'paid')).ready).toBe(true);
    const { input, output } = derivedAndExternal();
    const external = analyze({ input, output: output.map((row) => [row[0]!, row[1]!, row[3]!]) });
    expect(aiReadiness(external, preflight(external, 'paid')).ready).toBe(true);
  });
});

describe('learnFromExamples: a derived column reaches the AI step', () => {
  async function run(pair: Pair, ai: 'allowed' | 'notAllowed') {
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

  it('signed in: the learn call is made, with the bands hint and no skipColumns', async () => {
    const { res, calls } = await run(sizePair(PERM30), 'allowed');
    expect(res.path).toBe('llm');
    expect(calls).toHaveLength(1);
    const payload = calls[0] as { hints: { rel: string }[]; skipColumns?: number[] };
    expect(payload.hints.map((h) => h.rel)).toContain('bands');
    expect(payload.skipColumns).toBeUndefined();
  });

  it('signed out: the partial result lists the derived column as needing the AI step, and no call is made', async () => {
    const { res, calls } = await run(sizePair(PERM30), 'notAllowed');
    expect(calls).toHaveLength(0);
    expect(res.path).toBe('partial');
    expect(res.partial).toMatchObject({ reason: 'aiNotAllowed', solved: ['Ref', 'Item'], needsAi: ['Size'], external: [] });
  });
});
