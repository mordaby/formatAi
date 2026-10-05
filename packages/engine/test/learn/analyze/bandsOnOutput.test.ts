// Bands on a COMPUTED output column (owner amendment 2026-10-05, SPEC 6.2 step 4, analyze/derived.ts (b')). The owner's example: a
// class by a total (Small below 1000, Medium below 5000, Big from 5000), where the total is itself an OUTPUT column (Qty * Price). No
// input column holds the total, so the bands test on the input saw nothing: the class column was external data, no hint was sent, and the
// AI step gave it up (`externalData`) with no `unsupportedDespiteEvidence` round. Now a column still external after every other test is
// tried once more, sorted by each output column an arithmetic relation explains on every row. Synthetic, domain-neutral data.
import { unsupportedDespiteEvidence, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { isDerivedColumn, isExternalColumn, type PairAnalysis } from '../../../src/learn/analyze';
import { relationsToHints } from '../../../src/learn/hints';
import { createMasker } from '../../../src/learn/mask';
import { partialRules } from '../../../src/learn/partial';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { aiReadiness } from '../../../src/learn/readiness';
import { analyzeOk, pick, rng, xlsx, type V } from './helpers';

const WORDS = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lantern'];

const classOf = (total: number): string => (total < 1000 ? 'Small' : total < 5000 ? 'Medium' : 'Big');

// Input:  Ref(0) Customer(1) Name(2) Qty(3) Time(4) Price(5) [Amount(6) = Qty * Price, with `inputTotal`]
// Output: Ref(0) Customer(1) Name(2) Qty(3) Price(4) Total(5) Class(6) [Dock(7), with `dock`]
const QTY = 3;
const PRICE = 5;
const TOTAL_OUT = 5;
const CLASS_OUT = 6;

interface PairOpts {
  /** The input holds the total too (column 6): bands on an input column, the rule that must win. */
  inputTotal?: boolean;
  /** An output column with no relation to anything: three values assigned at random. */
  dock?: boolean;
  /** One row's total is off by one: `mul` holds on 59 of 60 rows only. */
  offTotal?: boolean;
}

/** 60 rows. Prices in cents, so the totals are exact; the first four rows sit on both sides of 1000 and of 5000. */
function classPair(opts: PairOpts = {}): { input: V[][]; output: V[][] } {
  const r = rng(7);
  const docks = rng(11);
  const rows: [number, number][] = [
    [9, 11000], // 990: Small
    [10, 10000], // 1000: Medium
    [10, 49900], // 4990: Medium
    [20, 25000], // 5000: Big
  ];
  while (rows.length < 60) rows.push([1 + Math.floor(r() * 20), 500 + Math.floor(r() * 59500)]);
  const input: V[][] = [['Ref', 'Customer', 'Name', 'Qty', 'Time', 'Price', ...(opts.inputTotal ? ['Amount'] : [])]];
  const output: V[][] = [['Ref', 'Customer', 'Name', 'Qty', 'Price', 'Total', 'Class', ...(opts.dock ? ['Dock'] : [])]];
  rows.forEach(([qty, cents], i) => {
    const ref = `R-${1000 + i * 7}`;
    const customer = `C-${100 + (i % 12)}`;
    const name = `${WORDS[i % WORDS.length]} ${i}`;
    const time = `${String(8 + (i % 10)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`;
    const price = cents / 100;
    const total = (qty * cents) / 100;
    const shown = opts.offTotal && i === 30 ? total + 1 : total;
    input.push([ref, customer, name, qty, time, price, ...(opts.inputTotal ? [total] : [])]);
    output.push([ref, customer, name, qty, price, shown, classOf(total), ...(opts.dock ? [pick(docks, ['North', 'South', 'East'])] : [])]);
  });
  return { input, output };
}

function analyze(opts: PairOpts = {}): PairAnalysis {
  const { input, output } = classPair(opts);
  return analyzeOk(xlsx(input), xlsx(output));
}

const BANDS = [
  { lt: 1000, value: 'Small' },
  { gte: 1000, lt: 5000, value: 'Medium' },
  { gte: 5000, value: 'Big' },
];

describe('detection: a class by a total that is Qty * Price, both output columns', () => {
  const a = analyze({ dock: true });
  const total = a.columns[TOTAL_OUT]!;
  const cls = a.columns[CLASS_OUT]!;

  it('the total is explained on every row by mul of Qty and Price', () => {
    expect(total.relations[0]).toMatchObject({ rel: 'mul', in: [QTY, PRICE], coverage: 1 });
  });

  it('the class gets a bands derivation on the total: onOut = the total column, in = Qty and Price', () => {
    expect(cls.relations).toEqual([]);
    expect(cls.derived).toEqual({ kind: 'bands', in: [QTY, PRICE], onOut: TOTAL_OUT, bands: BANDS, coverage: 1, failing: [], failCount: 0 });
  });

  it('so it is derived (the AI step can solve it), not external', () => {
    expect(isDerivedColumn(cls)).toBe(true);
    expect(isExternalColumn(cls)).toBe(false);
  });

  it('a column with no relation to anything stays external', () => {
    const dock = a.columns[7]!;
    expect(dock.header).toBe('Dock');
    expect(dock.derived).toBeNull();
    expect(isExternalColumn(dock)).toBe(true);
  });
});

describe('only where there was no evidence', () => {
  it('bands on an INPUT column still win: with the total in the input too, the derivation is on that column, with no onOut', () => {
    const cls = analyze({ inputTotal: true }).columns[CLASS_OUT]!;
    expect(cls.derived).toEqual({ kind: 'bands', in: [6], bands: BANDS, coverage: 1, failing: [], failCount: 0 });
  });

  it('a total the relation explains on most rows only (coverage < 1) is no operand: the class stays external', () => {
    const a = analyze({ offTotal: true });
    expect(a.columns[TOTAL_OUT]!.relations[0]).toMatchObject({ rel: 'mul', in: [QTY, PRICE] });
    expect(a.columns[TOTAL_OUT]!.relations[0]!.coverage).toBeLessThan(1);
    expect(a.columns[CLASS_OUT]!.derived).toBeNull();
    expect(isExternalColumn(a.columns[CLASS_OUT]!)).toBe(true);
  });
});

describe('the hint and the payload', () => {
  const a = analyze();
  const pf = preflight(a, 'paid');

  it('the bands hint carries onOut, and the total keeps its own mul hint', () => {
    const hints = relationsToHints(a, pf);
    expect(hints.find((h) => 'out' in h && h.out === CLASS_OUT)).toEqual({ rel: 'bands', in: [QTY, PRICE], onOut: TOTAL_OUT, bands: BANDS, out: CLASS_OUT, coverage: 1 });
    expect(hints.find((h) => 'out' in h && h.out === TOTAL_OUT)).toEqual({ rel: 'mul', in: [QTY, PRICE], out: TOTAL_OUT, coverage: 1 });
  });

  it('masking on: the band values are the samples\' fake words, the thresholds stay real numbers', () => {
    const masker = createMasker(new TextEncoder().encode('bands-on-output-key'));
    const { payload } = buildPayload(a, pf, { masker });
    const hint = payload.hints.find((h) => 'out' in h && h.out === CLASS_OUT);
    if (!hint || hint.rel !== 'bands') throw new Error('no bands hint');
    expect(hint).toMatchObject({ in: [QTY, PRICE], onOut: TOTAL_OUT });
    expect(hint.bands.map((b) => [b.lt, b.gte])).toEqual([
      [1000, undefined],
      [5000, 1000],
      [undefined, 5000],
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/Small|Medium|Big/);
    // Each sample's class cell is the fake word of the band its total falls in.
    for (const s of payload.samples) {
      const out = s.out as (string | number)[];
      const band = hint.bands.find((b) => (b.gte === undefined || (out[TOTAL_OUT] as number) >= (b.gte as number)) && (b.lt === undefined || (out[TOTAL_OUT] as number) < (b.lt as number)))!;
      expect(out[CLASS_OUT]).toBe(band.value);
    }
    expect(new Set(hint.bands.map((b) => b.value)).size).toBe(3);
    expect(payload.hints.find((h) => 'out' in h && h.out === TOTAL_OUT)).toMatchObject({ rel: 'mul', in: [QTY, PRICE] });
  });

  it('an answer that gives the class up gets an unsupportedDespiteEvidence problem naming the total column (header, never a value)', () => {
    const { payload } = buildPayload(a, pf);
    const p = partialRules(a, pf);
    if ('reason' in p) throw new Error('unreachable');
    const answer: LearnResult = { ...p.rules, unsupported: [{ outputColumn: 'Class', reasonCode: 'externalData' }] };
    expect(unsupportedDespiteEvidence(answer, payload)).toEqual([
      {
        kind: 'unsupportedDespiteEvidence',
        out: CLASS_OUT,
        message: 'Column "Class": the app found it is built from "Qty", "Price" (bands on output column "Total"); write a rule for it.',
      },
    ]);
  });
});

describe('completion planning and readiness', () => {
  it('the class needs the AI step and is not "another source"; the total is built by code', () => {
    const a = analyze({ dock: true });
    const pf = preflight(a, 'paid');
    const p = partialRules(a, pf);
    if ('reason' in p) throw new Error('unreachable');
    expect(p.solved).toEqual(['Ref', 'Customer', 'Name', 'Qty', 'Price', 'Total']);
    expect(p.needsAi).toEqual(['Class', 'Dock']);
    expect(p.external).toEqual(['Dock']);
    // Pre-flight counts the one external column only; the readiness gate lets the AI step run.
    expect(pf.issues).toContainEqual({ code: 'unknownOutputColumns', severity: 'info', params: { count: 1 } });
    expect(aiReadiness(a, pf).ready).toBe(true);
  });
});
