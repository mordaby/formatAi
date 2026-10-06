// Amendment 2026-10-06 (SPEC 7.2): identifiers stored as numbers are masked. The bug: with masking on, `maskCell` sent every NUMBER
// real whatever its column, so an ID column, a customer number and a phone number stored as numbers in Excel (the common case) went to
// the AI as they were - in samples `in` and `out` - while the privacy page promises that ID numbers are replaced. Now a number in an
// `idLike` column is masked as its digits (and stays a number), an integer column the classification calls an identifier (its name, since
// the column classification of 2026-10-06) is masked the same way, and every path that sends cells uses the same classes
// (`learn/classify.ts`). A measure (an amount, a quantity) stays real.
import type { Expr, LearnPayload, LearnResult, PayloadCell, Sample } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples } from '../../../src/learn/flow';
import { loopStep, startLoop, wrongCount, type LoopContext } from '../../../src/learn/loop';
import { createMasker, maskRules, unmaskRules } from '../../../src/learn/mask';
import { classifyColumns } from '../../../src/learn/classify';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { verifyAgainstExample } from '../../../src/learn/verify';
import { isValidIsraeliId, makeValidIsraeliId } from '../../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';
import { xlsxBytesOf } from '../v5fixtures';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);

// ---------------------------------------------------------------------------
// The reproduction: תז (valid Israeli IDs), מספר לקוח, טלפון - all stored as numbers - a name, an amount; the output adds a label by
// the amount (bands). Profile types: תז idLike, מספר לקוח integer, טלפון idLike, שם text, סכום integer.
// ---------------------------------------------------------------------------

const NAMES = ['דנה כהן', 'יוסי לוי', 'מיכל אברהם', 'אבי מזרחי', 'רונית פרץ', 'משה ביטון', 'שרה דהן', 'דוד אזולאי', 'נועה פרידמן', 'עמית שפירא', 'תמר גבאי', 'אורי חדד'];
const AMOUNTS = [120, 950, 340, 1500, 80, 2200, 610, 45, 1800, 730, 260, 3100];
const CUT = 700;
const kindOf = (amount: number): string => (amount >= CUT ? 'גדול' : 'קטן');

interface Pair {
  input: V[][];
  output: V[][];
  ids: number[];
  customers: number[];
  phones: number[];
  amounts: number[];
}

function idOf(i: number): number {
  return Number(makeValidIsraeliId(String(31234500 + i * 1117).padStart(8, '0')));
}

/** `n` rows (12: the reproduction; more for the learning loop). */
function idPair(n = 12): Pair {
  const input: V[][] = [['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום']];
  const output: V[][] = [['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום', 'סוג']];
  const p: Pair = { input, output, ids: [], customers: [], phones: [], amounts: [] };
  for (let i = 0; i < n; i++) {
    const id = idOf(i);
    const customer = 100200 + i * 13;
    const phone = 525550100 + i * 37;
    const amount = i < AMOUNTS.length ? AMOUNTS[i]! : 40 + ((i * 397) % 3000);
    p.ids.push(id);
    p.customers.push(customer);
    p.phones.push(phone);
    p.amounts.push(amount);
    input.push([id, customer, phone, NAMES[i % NAMES.length]!, amount]);
    output.push([id, customer, phone, NAMES[i % NAMES.length]!, amount, kindOf(amount)]);
  }
  return p;
}

function samplesSide(samples: readonly Sample[], side: 'in' | 'out'): PayloadCell[] {
  return samples.flatMap((s) => (side === 'in' ? s.in : (s.out as PayloadCell[])));
}

/** Every real value of `values` that shows up in `json` (as digits anywhere, so a number written as text is caught too). */
function leaked(json: string, values: readonly number[]): number[] {
  return values.filter((v) => json.includes(String(v)));
}

describe('the reproduction: IDs, customer numbers and phones stored as numbers, with masking on', () => {
  const pair = idPair();
  const a = analyzeOk(xlsx(pair.input), xlsx(pair.output));
  const pf = preflight(a, 'paid');
  const { payload } = buildPayload(a, pf, { masker: createMasker(key('numeric-ids')) });
  const json = JSON.stringify(payload);

  it('the profile types are the reported ones (the setup)', () => {
    expect(a.input.profile.map((p) => p.type)).toEqual(['idLike', 'integer', 'idLike', 'text', 'integer']);
    expect(a.columns[5]!.derived?.kind).toBe('bands');
  });

  it('sends none of the 12 IDs, customer numbers or phones - in the samples `in`, in `out`, or anywhere in the payload', () => {
    for (const side of ['in', 'out'] as const) {
      const cells = JSON.stringify(samplesSide(payload.samples, side));
      expect(leaked(cells, pair.ids)).toEqual([]);
      expect(leaked(cells, pair.customers)).toEqual([]);
      expect(leaked(cells, pair.phones)).toEqual([]);
    }
    expect(leaked(json, [...pair.ids, ...pair.customers, ...pair.phones])).toEqual([]);
    expect(payload.samples).toHaveLength(12);
  });

  it('the customer number column does not carry its real smallest and largest value (stats.range)', () => {
    expect(payload.input.columns[1]!.stats?.range).toBeUndefined();
    expect(payload.output.columns[1]!.stats?.range).toBeUndefined();
    expect(payload.input.columns[4]!.stats?.range).toEqual([45, 3100]); // the amount: a measure, real
  });

  it('a masked ID is still a number of the same length, the same fake in `in` and `out`; an Israeli ID stays a valid one', () => {
    for (const s of payload.samples) {
      const out = s.out as PayloadCell[];
      for (const c of [0, 1, 2]) {
        expect(typeof s.in[c]).toBe('number');
        expect(out[c]).toBe(s.in[c]);
      }
      expect(String(s.in[0])).toHaveLength(9);
      expect(isValidIsraeliId(String(s.in[0]))).toBe(true);
      expect(String(s.in[1])).toHaveLength(6);
      expect(String(s.in[2])).toHaveLength(9);
    }
  });

  it('names stay masked; the amounts (used by the bands) stay real', () => {
    for (const name of NAMES) for (const word of name.split(' ')) expect(json).not.toContain(word);
    expect(samplesSide(payload.samples, 'in').filter((v) => typeof v === 'number' && AMOUNTS.includes(v))).toHaveLength(12);
    const bands = payload.hints.find((h) => h.rel === 'bands') as { bands: { lt?: number; gte?: number }[] } | undefined;
    expect(bands?.bands.some((b) => b.lt === CUT || b.gte === CUT)).toBe(true);
  });

  it('a title that names a customer number does not make its digits a label word sent real', () => {
    const output: V[][] = [['דוח לקוח 100213'], [], ...pair.output];
    const titled = analyzeOk(xlsx(pair.input), xlsx(output));
    expect(titled.layout.titleRows[0]?.text).toBe('דוח לקוח 100213');
    const sent = JSON.stringify(buildPayload(titled, preflight(titled, 'paid'), { masker: createMasker(key('title')) }).payload);
    expect(sent).not.toContain('100213');
    expect(leaked(sent, [...pair.ids, ...pair.customers, ...pair.phones])).toEqual([]);
  });

  it('with masking off everything is sent real, as before', () => {
    const plain = buildPayload(a, pf).payload;
    const cells = JSON.stringify(plain.samples);
    expect(leaked(cells, pair.ids)).toHaveLength(12);
    expect(leaked(cells, pair.customers)).toHaveLength(12);
    expect(leaked(cells, pair.phones)).toHaveLength(12);
    expect(plain.samples[0]!.in).toEqual([pair.ids[0], pair.customers[0], pair.phones[0], NAMES[0], AMOUNTS[0]]);
    expect(plain.input.columns[1]!.stats?.range).toEqual([100200, 100343]);
  });
});

// ---------------------------------------------------------------------------
// Which integer columns are identifiers: since the column classification (owner, 2026-10-06), the name decides - not uniqueness or use.
// ---------------------------------------------------------------------------

describe('classifyColumns: an integer identifier is masked, a measure stays real', () => {
  const classes = (a: ReturnType<typeof analyzeOk>) => ({ input: classifyColumns(a).input, output: classifyColumns(a).output });

  it('the reproduction: the customer number (its name) is an identifier; the amount (bands) is a measure', () => {
    const pair = idPair();
    const a = analyzeOk(xlsx(pair.input), xlsx(pair.output));
    expect(classifyColumns(a).detail.input[1]).toEqual({ class: 'identifier', by: 'name' });
    expect(classes(a)).toEqual({
      input: ['identifier', 'identifier', 'identifier', 'text', 'measure'],
      output: ['identifier', 'identifier', 'identifier', 'text', 'measure', 'text'],
    });
  });

  /** A unique integer key, only copied (`key`), Qty: unique integers too, but the total is Qty * Price. */
  function totalPair(key: string): { input: V[][]; output: V[][] } {
    const input: V[][] = [[key, 'Qty', 'Price']];
    const output: V[][] = [[key, 'Qty', 'Total']];
    for (let i = 0; i < 12; i++) {
      const ref = 400100 + i * 7;
      const qty = 3 + ((i * 5) % 12) + i * 12; // all different
      const price = 2.5 + (i % 4);
      input.push([ref, qty, price]);
      output.push([ref, qty, qty * price]);
    }
    return { input, output };
  }

  it('an integer quantity used in `mul` stays real; the integer key named as an identifier is masked', () => {
    const { input, output } = totalPair('Account No');
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.input.profile.map((p) => [p.type, p.key])).toEqual([['integer', true], ['integer', true], ['decimal', false]]);
    expect(a.columns[2]!.relations[0]!.rel).toBe('mul');
    expect(classes(a)).toEqual({ input: ['identifier', 'measure', 'measure'], output: ['identifier', 'measure', 'measure'] });

    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('mul')) });
    const sent = JSON.stringify(payload.samples);
    const rows = input.slice(1) as number[][];
    expect(leaked(sent, rows.map((r) => r[0]!))).toEqual([]);
    for (const s of payload.samples) {
      const real = rows.find((r) => r[1] === s.in[1] && r[2] === s.in[2]);
      expect(real).toBeDefined(); // Qty and Price arrive as they are, so the AI step can see Total = Qty * Price
      expect((s.out as PayloadCell[])[2]).toBe(real![1]! * real![2]!);
    }
  });

  // WHETHER changed (owner, 2026-10-06): #56 masked this unique, only-copied integer column whatever its name. A name with no identifier
  // word now leaves it a measure, sent real - the documented limit the external classification (the AI step, later) is for.
  it('the same key named "Ref" (no identifier word) is a measure, sent real', () => {
    const { input, output } = totalPair('Ref');
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(classes(a).input).toEqual(['measure', 'measure', 'measure']);
    const sent = JSON.stringify(buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('ref')) }).payload.samples);
    expect(leaked(sent, (input.slice(1) as number[][]).map((r) => r[0]!))).toHaveLength(12);
  });

  it('an integer column with a filter threshold is a measure', () => {
    // Score: unique integers; the rows below 50 are dropped.
    const input: V[][] = [['Ref', 'Score']];
    const output: V[][] = [['Ref', 'Score']];
    for (let i = 0; i < 16; i++) {
      const score = 10 + i * 7;
      input.push([`R-${i}`, score]);
      if (score >= 50) output.push([`R-${i}`, score]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(a.dropped.filters[0]?.droppedWhen?.op).toMatch(/^(gte|lt)$/);
    expect(classifyColumns(a).input[1]).toBe('measure');
  });

  it('an integer column that is not unique per row and not named as an identifier is a measure (a code repeated across rows)', () => {
    const input: V[][] = [['Branch', 'Name']];
    const output: V[][] = [['Name', 'Branch']];
    for (let i = 0; i < 12; i++) {
      input.push([101 + (i % 3), `N${i}`]);
      output.push([`N${i}`, 101 + (i % 3)]);
    }
    const a = analyzeOk(xlsx(input), xlsx(output));
    expect(classifyColumns(a).input).toEqual(['measure', 'text']);
  });
});

// ---------------------------------------------------------------------------
// The masker: a number in an ID column.
// ---------------------------------------------------------------------------

describe('Masker.maskCell: a number in an idLike column', () => {
  it('is masked like the same digits as text, and stays a number of the same length', () => {
    const m = createMasker(key('cell'));
    const fake = m.maskCell(312345002, 'identifier');
    expect(typeof fake).toBe('number');
    expect(fake).not.toBe(312345002);
    expect(String(fake)).toBe(m.maskCell('312345002', 'identifier'));
    expect(isValidIsraeliId(String(fake))).toBe(true);
    expect(m.fakeToReal.get(String(fake))).toBe('312345002');
    // inside text, the same ID gets the same fake (SPEC 7.2: the same real word becomes the same fake word)
    expect(m.maskCell('312345002 - Cohen', 'text')).toBe(`${fake} - ${m.maskCell('Cohen', 'text')}`);
  });

  it('keeps the length of an ID whose leading zero was lost, a valid ID after padding', () => {
    const m = createMasker(key('short'));
    const real = Number(makeValidIsraeliId('04021776')); // "04021776x", stored as a number: 8 digits
    expect(String(real)).toHaveLength(8);
    const fake = m.maskCell(real, 'identifier');
    expect(typeof fake).toBe('number');
    expect(String(fake)).toHaveLength(8);
    expect(isValidIsraeliId(String(fake))).toBe(true);
  });

  it('a number that is no Israeli ID keeps its digit count and never gains a leading zero', () => {
    const m = createMasker(key('lead'));
    for (let n = 100200; n < 100200 + 13 * 300; n += 13) {
      const fake = m.maskCell(n, 'identifier') as number;
      expect(typeof fake).toBe('number');
      expect(String(fake)).toHaveLength(6);
    }
    for (let n = 1; n < 400; n++) expect(String(m.maskCell(n, 'identifier'))).toHaveLength(String(n).length);
  });

  it('numbers in other columns are sent real, as before', () => {
    const m = createMasker(key('other'));
    expect(m.maskCell(312345002, 'measure')).toBe(312345002);
    expect(m.maskCell(1234.5, 'measure')).toBe(1234.5);
    expect(m.maskCell(312345002, 'text')).toBe(312345002);
  });
});

// ---------------------------------------------------------------------------
// Unmasking: a constant written as the fake, as text or as a number.
// ---------------------------------------------------------------------------

describe('unmaskRules: a fake ID written as a number constant', () => {
  const m = createMasker(key('unmask'));
  const realId = 312345002;
  const fakeId = m.maskCell(realId, 'identifier') as number;
  const realCustomer = 100213;
  const fakeCustomer = m.maskCell(realCustomer, 'identifier') as number;
  const shortFake = m.maskCell(37, 'identifier') as number;

  it('unmasks the fake to the real value, written as text or as a number, in every constant position', () => {
    const rules = {
      transform: {
        computed: [
          { id: 'a', type: 'integer', expr: { op: 'if', cond: { op: 'eq', args: [{ col: 'id' }, { const: fakeId }] }, then: { const: 1 }, else: { const: 0 } } },
          { id: 'b', type: 'text', expr: { op: 'eq', args: [{ col: 'id' }, { const: String(fakeId) }] } },
          { id: 'c', type: 'boolean', expr: { op: 'oneOf', arg: { col: 'cust' }, values: [fakeCustomer, 5] } },
        ],
        tables: [{ name: 't', columns: ['k', 'v'], rows: [[fakeCustomer, 'x']] }],
      },
      input: { rowFilters: [{ column: 'cust', op: 'ne', value: fakeCustomer }] },
    };
    const real = unmaskRules(rules, m);
    expect(real.transform.computed[0]!.expr).toEqual({ op: 'if', cond: { op: 'eq', args: [{ col: 'id' }, { const: realId }] }, then: { const: 1 }, else: { const: 0 } });
    expect(real.transform.computed[1]!.expr).toEqual({ op: 'eq', args: [{ col: 'id' }, { const: String(realId) }] });
    expect(real.transform.computed[2]!.expr).toEqual({ op: 'oneOf', arg: { col: 'cust' }, values: [realCustomer, 5] });
    expect(real.transform.tables[0]!.rows).toEqual([[realCustomer, 'x']]);
    expect(real.input.rowFilters[0]!.value).toBe(realCustomer);
  });

  it('only numbers that are the fake of a whole ID: any other number, a short fake, and structural numbers stay as they are', () => {
    const rules = {
      expr: { op: 'add', args: [{ const: 1234567 }, { const: shortFake }] },
      round: { op: 'round', arg: { col: 'x' }, digits: 2 },
      substr: { op: 'substr', arg: { col: 'x' }, start: fakeId, length: 3 },
      check: { column: 'x', rule: 'range', min: fakeId, max: fakeCustomer },
    };
    expect(unmaskRules(rules, m)).toEqual(rules);
  });

  it('a completion call masks a real ID number constant the same way (maskRules), and unmasking restores it', () => {
    const rules = { transform: { computed: [{ id: 'a', type: 'boolean', expr: { op: 'eq', args: [{ col: 'id' }, { const: realId }] } }] } };
    const masked = maskRules(rules, m);
    expect(masked.transform.computed[0]!.expr).toEqual({ op: 'eq', args: [{ col: 'id' }, { const: fakeId }] });
    expect(unmaskRules(masked, m)).toEqual(rules);
  });
});

// ---------------------------------------------------------------------------
// A full learn: the AI answer (a fake LLM) copies the ID column and uses one ID constant, written as the number it saw.
// ---------------------------------------------------------------------------

describe('learnFromExamples with masking on: a rule that uses a masked numeric ID verifies on the real data', () => {
  it('copies the ID column and flags one ID by its fake; the saved rules hold the real ID', async () => {
    const pair = idPair();
    const VIP = 5;
    const input = pair.input.map((r) => r.slice(0, 4));
    const output: V[][] = [['תז', 'מספר לקוח', 'שם', 'VIP'], ...pair.input.slice(1).map((r, i) => [r[0]!, r[1]!, r[3]!, i === VIP ? 1 : 0])];
    let seenFake: number | undefined;
    let payloadSent: LearnPayload | undefined;
    const col = (id: string): Expr => ({ col: id });

    const result = await learnFromExamples({
      input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
      masking: true,
      key: key('round-trip'),
      tier: 'registered',
      callLearn: async (payload) => {
        payloadSent = payload;
        const flagged = payload.samples.find((s) => (s.out as PayloadCell[])[3] === 1);
        seenFake = flagged?.in[0] as number;
        const answer: LearnResult = {
          schemaVersion: 1,
          input: {
            sheet: { pick: 'first' },
            headerRow: 'auto',
            columns: [
              { id: 'id', header: 'תז', type: 'integer' },
              { id: 'customer', header: 'מספר לקוח', type: 'integer' },
              { id: 'phone', header: 'טלפון', type: 'integer' },
              { id: 'name', header: 'שם', type: 'text' },
            ],
          },
          transform: {
            computed: [{ id: 'vip', type: 'integer', expr: { op: 'if', cond: { op: 'eq', args: [col('id'), { const: seenFake }] }, then: { const: 1 }, else: { const: 0 } } }],
            valueMaps: [],
            sort: [],
          },
          output: {
            sheetName: 'Sheet1',
            direction: 'ltr',
            language: 'en',
            titleRows: [],
            columns: [
              { header: 'תז', from: 'id' },
              { header: 'מספר לקוח', from: 'customer' },
              { header: 'שם', from: 'name' },
              { header: 'VIP', from: 'vip' },
            ],
          },
          validations: [],
          unsupported: [],
          assumptions: [],
        };
        return { rules: answer, problems: [], calls: [] };
      },
    });

    expect(payloadSent).toBeDefined();
    expect(leaked(JSON.stringify(payloadSent), [...pair.ids, ...pair.customers, ...pair.phones])).toEqual([]);
    expect(typeof seenFake).toBe('number');
    expect(seenFake).not.toBe(pair.ids[VIP]);
    expect(result.path).toBe('llm');
    expect(result.verification?.verified).toBe(true);
    const saved = JSON.stringify(result.rules);
    expect(saved).toContain(`{"const":${pair.ids[VIP]}}`);
    expect(saved).not.toContain(String(seenFake));
  });
});

// ---------------------------------------------------------------------------
// The other paths that send cells: the full verification's repair problems and the learning loop's rows.
// ---------------------------------------------------------------------------

describe('repair rows and the learning loop\'s rows are masked the same way', () => {
  const pair = idPair(40);
  const a = analyzeOk(xlsx(pair.input), xlsx(pair.output));
  const masker = createMasker(key('loop'));
  const built = buildPayload(a, preflight(a, 'paid'), { masker });

  /** The pair's rules with the label cut at `cut` (700 is right): the rows with an amount between the two are wrong. */
  const rules = (cut: number): LearnResult => ({
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: 'תז', type: 'integer' },
        { id: 'customer', header: 'מספר לקוח', type: 'integer' },
        { id: 'phone', header: 'טלפון', type: 'integer' },
        { id: 'name', header: 'שם', type: 'text' },
        { id: 'amount', header: 'סכום', type: 'integer' },
      ],
    },
    transform: {
      computed: [{ id: 'kind', type: 'text', expr: { op: 'if', cond: { op: 'gte', args: [{ col: 'amount' }, { const: cut }] }, then: { const: 'גדול' }, else: { const: 'קטן' } } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: ['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום'].map((header, i) => ({ header, from: ['id', 'customer', 'phone', 'name', 'amount'][i]! })).concat([{ header: 'סוג', from: 'kind' }]),
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  });
  const all = [...pair.ids, ...pair.customers, ...pair.phones];

  it('the full verification\'s repair problems carry no real ID, customer number or phone (the UI copy stays real)', () => {
    expect(verifyAgainstExample(rules(CUT), a).verified).toBe(true);
    const v = verifyAgainstExample(rules(1000), a, { masker, wrongRows: true });
    const diffs = v.repairProblems.filter((p) => p.kind === 'diff');
    expect(diffs.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(v.repairProblems), all)).toEqual([]);
    for (const d of diffs) {
      expect(typeof d.row!.in[0]).toBe('number');
      expect(d.row!.in[4]).toBe(d.row!.out[4]); // the amount: real, the same on both sides
      expect(pair.amounts).toContain(d.row!.in[4]);
    }
  });

  it('completion mode: an ID number in the rules to keep is sent as its fake, even one no sent row holds', () => {
    const sent = new Set(built.sampleRows.map((s) => s.in));
    const row = pair.customers.findIndex((_, i) => !sent.has(i));
    const fixed = rules(CUT);
    fixed.input.rowFilters = [{ column: 'customer', op: 'ne', value: pair.customers[row]! }];
    const m = createMasker(key('complete'));
    const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: m, complete: { fixedRules: fixed, columns: [5], parts: [] } });
    const json = JSON.stringify(payload.complete);
    expect(leaked(json, all)).toEqual([]);
    expect(json).toContain(String(m.maskCell(pair.customers[row]!, 'identifier')));
    expect(json).toContain(String(CUT)); // a threshold: real
  });

  it('the loop\'s rows and problems carry none either, with the same fake as the payload\'s samples for the same row', () => {
    const v = verifyAgainstExample(rules(1000), a, { wrongRows: true });
    const ctx: LoopContext = { analysis: a, payload: built.payload, masker, caps: { maxRounds: 3, rowsPerRound: 8, maxRowsTotal: 40, maxBytes: 49_152 } };
    const start = startLoop([...built.sampleRows.map((s) => s.in), ...built.droppedRows]);
    const r = loopStep(start, { rules: true, passes: false, wrong: wrongCount(v.wrongRows!, v.layoutIssues.length), wrongRows: v.wrongRows!, otherProblems: [] }, ctx);
    if (r.step.kind !== 'next') throw new Error(`expected a round, got ${r.step.kind}`);
    expect(r.step.rows.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(r.step), all)).toEqual([]);
    for (const row of r.step.rows) {
      const fake = row.sample.in[0];
      expect(typeof fake).toBe('number');
      expect(fake).toBe(masker.maskCell(pair.ids[row.inRow]!, 'identifier'));
      expect(row.sample.in[4]).toBe(pair.amounts[row.inRow]); // the amount: real
    }
  });
});
