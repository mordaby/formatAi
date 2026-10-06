// The AI code checks with masking on, on identifiers stored as numbers (amendment 2026-10-06, SPEC 7.2): every answer masks an identifier
// column exactly like the payload does - the same per-column decision (`classifyColumns`) and the same masker - in its rows, failing and conflict
// rows, top values, dependsOn keys and test's expected / got; `values` gives no min / max of one, `ranges` refuses to sort by one, and a
// fake ID the AI writes in a formula (`where`, `rule`, `let`) is unmasked like a rule's constant. The measures stay real.
import type { Check, CheckAnswer, CheckRound, DependsOnAnswer, LearnPayload, LearnResult, PayloadCell, RangesAnswer, RowsAnswer, TestAnswer, ValuesAnswer } from '@formatai/shared';
import { limits, payloadRowCount } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { answerChecks, type CheckContext } from '../../src/learn/checks';
import { learnFromExamples } from '../../src/learn/flow';
import { createMasker } from '../../src/learn/mask';
import { classifyColumns } from '../../src/learn/classify';
import { buildPayload } from '../../src/learn/payload';
import { preflight } from '../../src/learn/preflight';
import { makeValidIsraeliId } from '../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from './analyze/helpers';
import { xlsxBytesOf } from './v5fixtures';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);

// תז (valid Israeli IDs, idLike), מספר לקוח (integers named as an identifier), טלפון (idLike) - all stored as numbers -, a name,
// and an amount (a measure: the label סוג is cut by it at 700).
const NAMES = ['דנה כהן', 'יוסי לוי', 'מיכל אברהם', 'אבי מזרחי', 'רונית פרץ', 'משה ביטון', 'שרה דהן', 'דוד אזולאי', 'נועה פרידמן', 'עמית שפירא', 'תמר גבאי', 'אורי חדד'];
const CUT = 700;
const kindOf = (amount: number): string => (amount >= CUT ? 'גדול' : 'קטן');
const N = 40;

const ids: number[] = [];
const customers: number[] = [];
const phones: number[] = [];
const amounts: number[] = [];
const input: V[][] = [['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום']];
const output: V[][] = [['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום', 'סוג']];
for (let i = 0; i < N; i++) {
  const id = Number(makeValidIsraeliId(String(31234500 + i * 1117).padStart(8, '0')));
  const customer = 100200 + i * 13;
  const phone = 525550100 + i * 37;
  const amount = 40 + ((i * 397) % 3000);
  ids.push(id);
  customers.push(customer);
  phones.push(phone);
  amounts.push(amount);
  input.push([id, customer, phone, NAMES[i % NAMES.length]!, amount]);
  output.push([id, customer, phone, NAMES[i % NAMES.length]!, amount, kindOf(amount)]);
}
const ALL = [...ids, ...customers, ...phones];

/** Every real identifier that shows up in `json` (as digits anywhere: a number written as text is caught too). */
function leaked(json: string): number[] {
  return ALL.filter((v) => json.includes(String(v)));
}

const analysis = analyzeOk(xlsx(input), xlsx(output));
/** As in the flow: the payload is built first (its samples masked), then the checks are answered with the same masker. */
function session(seed: string) {
  const masker = createMasker(key(seed));
  const built = buildPayload(analysis, preflight(analysis, 'paid'), { masker });
  const sent = new Set([...built.sampleRows.map((s) => s.in), ...built.droppedRows]);
  const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
    analysis,
    masker,
    sent,
    rowBudget: limits.learn.loop.maxRowsTotal - payloadRowCount(built.payload),
    ...over,
  });
  return { masker, built, sent, ctx };
}

describe('the AI code checks mask identifiers stored as numbers like the payload does', () => {
  const s = session('checks-ids');
  const { masker } = s;
  const one = (check: Check, over: Partial<CheckContext> = {}): CheckAnswer => answerChecks([check], s.ctx(over)).answers[0]!;
  const BIG = masker.maskText('גדול');
  const SMALL = masker.maskText('קטן');

  it('the setup: תז, customer number and phone are masked as IDs, the amount is a measure; the payload sends none of them', () => {
    const { input: inClasses, output: outClasses } = classifyColumns(analysis);
    expect({ input: inClasses, output: outClasses }).toEqual({
      input: ['identifier', 'identifier', 'identifier', 'text', 'measure'],
      output: ['identifier', 'identifier', 'identifier', 'text', 'measure', 'text'],
    });
    expect(leaked(JSON.stringify(s.built.payload))).toEqual([]);
    expect(s.sent.size).toBeLessThan(N);
  });

  it('test: failing rows carry no real ID, customer number or phone; the amounts in them stay real', () => {
    const r = answerChecks([{ check: 'test', column: 'סוג', rule: `if(in4 >= 1000, "${BIG}", "${SMALL}")` }], s.ctx());
    const a = r.answers[0] as TestAnswer;
    expect(a.rows).toBe(N);
    expect(a.matched).toBe(N - amounts.filter((x) => x >= CUT && x < 1000).length);
    expect(a.failing.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(a))).toEqual([]);
    for (const f of a.failing) {
      expect([f.expected, f.got]).toEqual([BIG, SMALL]);
      const inRow = amounts.indexOf(f.row.in[4] as number);
      expect(inRow).toBeGreaterThanOrEqual(0); // the amount: real
      expect(f.row.in.slice(0, 3)).toEqual([ids[inRow]!, customers[inRow]!, phones[inRow]!].map((v) => masker.maskCell(v, 'identifier')));
      expect((f.row.out as PayloadCell[]).slice(0, 3)).toEqual(f.row.in.slice(0, 3)); // the same fake in `in` and `out`
    }
  });

  it('test on an identifier column: expected and got are masked; got is masked too when a wrong rule reads an ID for a measure', () => {
    const a = one({ check: 'test', column: 'תז', rule: 'in1' }) as TestAnswer;
    expect(a.matched).toBe(0);
    expect(a.failing).toHaveLength(limits.learn.checks.maxFailingRows);
    expect(leaked(JSON.stringify(a))).toEqual([]);
    for (const f of a.failing) {
      const inRow = ids.indexOf(masker.realNumberOf(f.expected as number)!);
      expect(inRow).toBeGreaterThanOrEqual(0);
      expect(f.expected).toBe(masker.maskCell(ids[inRow]!, 'identifier'));
      expect(f.got).toBe(masker.maskCell(customers[inRow]!, 'identifier'));
    }
    const b = one({ check: 'test', column: 'סכום', let: [{ id: 'c', expr: 'in1 + 0' }], rule: 'c' }) as TestAnswer;
    expect(b.matched).toBe(0);
    expect(b.failing.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(b))).toEqual([]);
    for (const f of b.failing) {
      expect(amounts).toContain(f.expected); // the amount: real
      expect(typeof f.got).toBe('number');
      expect(String(f.got)).toHaveLength(6);
    }
  });

  it('values: an identifier column (or a helper that copies one) shows masked top values and no min / max', () => {
    for (const column of ['תז', 'מספר לקוח', 'טלפון', 'in1']) {
      const a = one({ check: 'values', column }) as ValuesAnswer;
      expect(a).toMatchObject({ rows: N, distinct: N, empty: 0 });
      expect(a.top.length).toBeGreaterThan(0);
      expect(a.min).toBeUndefined();
      expect(a.max).toBeUndefined();
      expect(leaked(JSON.stringify(a))).toEqual([]);
      for (const t of a.top) expect(typeof t.value).toBe('number');
    }
    const copied = one({ check: 'values', column: 'c', let: [{ id: 'c', expr: 'in1' }] }) as ValuesAnswer;
    expect(copied.min).toBeUndefined();
    expect(leaked(JSON.stringify(copied))).toEqual([]);
    expect(copied.top.map((t) => t.value)).toEqual((one({ check: 'values', column: 'in1' }) as ValuesAnswer).top.map((t) => t.value));
  });

  it('values: a measure stays real - its top values, min and max', () => {
    const a = one({ check: 'values', column: 'סכום' }) as ValuesAnswer;
    expect(a.min).toBe(Math.min(...amounts));
    expect(a.max).toBe(Math.max(...amounts));
    for (const t of a.top) expect(amounts).toContain(t.value);
  });

  it('ranges: sorting by an identifier column (or a helper computed from one) is refused; by a measure it is real', () => {
    for (const by of ['תז', 'מספר לקוח', 'טלפון', 'in0']) {
      expect(one({ check: 'ranges', column: 'סוג', by })).toEqual({ error: 'by: sorting by an identifier column is not supported' });
    }
    expect(one({ check: 'ranges', column: 'סוג', by: 'c', let: [{ id: 'c', expr: 'in1 * 2' }] })).toEqual({ error: 'by: sorting by an identifier column is not supported' });
    const a = one({ check: 'ranges', column: 'סוג', by: 'סכום' }) as RangesAnswer;
    expect(a.clean).toBe(true);
    if (!a.clean) return;
    const small = amounts.filter((x) => x < CUT);
    const big = amounts.filter((x) => x >= CUT);
    expect(a.runs).toEqual([
      { from: Math.min(...small), to: Math.max(...small), value: SMALL, rows: small.length },
      { from: Math.min(...big), to: Math.max(...big), value: BIG, rows: big.length },
    ]);
    // An identifier column as the column a range shows: its values are masked.
    const ids2 = one({ check: 'ranges', column: 'תז', by: 'סכום' });
    expect(leaked(JSON.stringify(ids2))).toEqual([]);
  });

  it('ranges by an identifier column with masking off: answered as before (nothing is masked)', () => {
    const a = one({ check: 'ranges', column: 'סוג', by: 'מספר לקוח' }, { masker: undefined }) as RangesAnswer;
    expect('error' in a).toBe(false);
    expect(a.rows).toBe(N);
  });

  it('dependsOn: the keys, the values and the conflict rows carry no real identifier', () => {
    const byName = one({ check: 'dependsOn', column: 'תז', on: ['שם'] }) as DependsOnAnswer;
    expect(byName.keysConflict).toBe(NAMES.length);
    expect(byName.conflicts.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(byName))).toEqual([]);
    for (const c of byName.conflicts) for (const v of c.values) expect(typeof v).toBe('number');

    // A key computed from the customer number (its hundreds): repeated, so it has conflicts, and masked like an ID.
    const hundreds = [...new Set(customers.map((c) => c - (c % 100)))];
    const byHundreds = one({ check: 'dependsOn', column: 'סוג', on: ['h'], let: [{ id: 'h', expr: 'in1 - mod(in1, 100)' }] }) as DependsOnAnswer;
    expect(byHundreds.keys).toBe(hundreds.length);
    expect(byHundreds.conflicts.length).toBeGreaterThan(0);
    expect(leaked(JSON.stringify(byHundreds))).toEqual([]);
    for (const c of byHundreds.conflicts) {
      expect(typeof c.key[0]).toBe('number');
      expect(hundreds).not.toContain(c.key[0]);
      expect(hundreds.map((h) => masker.maskCell(h, 'identifier'))).toContain(c.key[0]);
    }
  });

  it('rows: the rows shown carry no real identifier, and they count toward the learn\'s row limit', () => {
    // Rows the payload did not send (picked by their amount, a real measure).
    const unsent = amounts.map((_, i) => i).filter((i) => !s.sent.has(i));
    const where = `oneOf(in4, ${unsent.map((i) => amounts[i]).join(', ')})`;
    const limit = limits.learn.checks.maxRowsPerCheck;
    const r = answerChecks([{ check: 'rows', where, limit }], s.ctx());
    const a = r.answers[0] as RowsAnswer;
    expect(a.matched).toBe(unsent.length);
    expect(a.rows).toHaveLength(Math.min(limit, unsent.length));
    expect(leaked(JSON.stringify(a))).toEqual([]);
    expect(r.rowsShown).toEqual(unsent.slice(0, a.rows.length));
    for (const [n, row] of a.rows.entries()) expect(row.in[1]).toBe(masker.maskCell(customers[unsent[n]!]!, 'identifier'));
    // ... and past the limit they are withheld, still masked
    const tight = answerChecks([{ check: 'rows', where, limit }], s.ctx({ rowBudget: 1 }));
    expect(tight.rowsShown).toHaveLength(1);
    expect((tight.answers[0] as RowsAnswer).withheld).toBe(Math.min(limit, unsent.length) - 1);
    expect(leaked(JSON.stringify(tight.answers))).toEqual([]);
  });
});

describe('a fake ID the AI writes in a formula is unmasked like a rule\'s constant (unmaskRules, numeric fakes included)', () => {
  const s = session('checks-where');
  const sample = s.built.payload.samples[3]!;
  const row = s.built.sampleRows[3]!.in;
  const [fakeId, fakeCustomer, fakePhone] = sample.in as [number, number, number];

  it('the sample row carries fakes, numbers of the real lengths', () => {
    expect([fakeId, fakeCustomer, fakePhone]).not.toEqual([ids[row], customers[row], phones[row]]);
    expect([fakeId, fakeCustomer, fakePhone].map((v) => typeof v)).toEqual(['number', 'number', 'number']);
  });

  it('where on a masked ID constant filters to the real row (תז, customer number, phone; = and oneOf)', () => {
    // The customer number is an integer column (an identifier by its name, `classifyColumns`): a number constant. תז and the phone are idLike columns,
    // which a check reads as an ID (`in0 = 123` is a type error there, masked or not): their digits are written as text.
    for (const [col, fake] of [['in1', `${fakeCustomer}`], ['in0', `"${fakeId}"`], ['in2', `"${fakePhone}"`]] as const) {
      const r = answerChecks([{ check: 'rows', where: `${col} = ${fake}`, limit: 5 }], s.ctx());
      const a = r.answers[0] as RowsAnswer;
      expect(a.matched).toBe(1);
      expect(a.rows).toEqual([sample]); // the sample row, as the payload sent it (already sent: not counted again)
      expect(r.rowsShown).toEqual([]);
    }
    const other = s.built.payload.samples[5]!.in[1] as number;
    const both = answerChecks([{ check: 'values', column: 'סכום', where: `oneOf(in1, ${fakeCustomer}, ${other})` }], s.ctx()).answers[0] as ValuesAnswer;
    expect(both.rows).toBe(2);
    expect(both.top.map((t) => t.value).sort()).toEqual([amounts[row], amounts[s.built.sampleRows[5]!.in]].sort());
  });

  it('in a rule and a let too; the real number written by the AI is not a fake and matches nothing it should not', () => {
    const t = answerChecks(
      [{ check: 'test', column: 'סוג', let: [{ id: 'vip', expr: `in1 = ${fakeCustomer}` }], rule: `if(vip, "${s.masker.maskText('גדול')}", "${s.masker.maskText('קטן')}")` }],
      s.ctx(),
    ).answers[0] as TestAnswer;
    // the rule gives גדול to that one row only: it is right on every row whose label agrees
    const vipRight = kindOf(amounts[row]!) === 'גדול' ? 1 : 0;
    expect(t.matched).toBe(amounts.filter((x, i) => i !== row && kindOf(x) === 'קטן').length + vipRight);
    expect(leaked(JSON.stringify(t))).toEqual([]);
  });
});

describe('learnFromExamples with masking on: the step\'s rounds carry no real identifier, and the check rows count toward the limit', () => {
  it('a round of checks on the IDs, a where on a fake ID, then the rules', async () => {
    const stepCalls: { payload: LearnPayload; rounds: CheckRound[] }[] = [];
    let fake: number | undefined;
    const result = await learnFromExamples({
      input: { bytes: await xlsxBytesOf(input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(output), name: 'out.xlsx' },
      masking: true,
      key: key('flow-checks'),
      tier: 'paid',
      callLearn: async (payload) => {
        fake = payload.samples[0]!.in[1] as number;
        // (the amounts are real: the rows the samples do not hold, by their amount)
        const seen = new Set(payload.samples.map((x) => x.in[4]));
        const unsent = amounts.filter((x) => !seen.has(x));
        const checks: Check[] = [
          { check: 'values', column: 'מספר לקוח' },
          { check: 'rows', where: `in1 = ${fake}`, limit: 3 },
          { check: 'ranges', column: 'סוג', by: 'סכום' },
          { check: 'rows', where: `oneOf(in4, ${unsent.join(', ')})`, limit: limits.learn.checks.maxRowsPerCheck },
        ];
        return { rules: null, checks, problems: [], calls: ['learn'] };
      },
      callStep: async (payload, rounds) => {
        stepCalls.push({ payload, rounds });
        return { rules: rulesOf(CUT), problems: [], calls: ['step'] };
      },
    });
    expect(stepCalls).toHaveLength(1);
    const { payload, rounds } = stepCalls[0]!;
    expect(leaked(JSON.stringify({ payload, rounds }))).toEqual([]);
    const [values, byFake, ranges, rows] = rounds[0]!.answers as [ValuesAnswer, RowsAnswer, RangesAnswer, RowsAnswer];
    expect(values.min).toBeUndefined();
    expect(byFake.matched).toBe(1);
    expect(byFake.rows[0]!.in[1]).toBe(fake);
    expect(ranges.clean).toBe(true);
    expect(rows.rows.length).toBeGreaterThan(0);
    // the rows the checks showed count toward the learn's row limit with the payload's own
    expect(result.checks?.rowsShown).toBeGreaterThan(0);
    expect(payloadRowCount(payload) + result.checks!.rowsShown).toBeLessThanOrEqual(limits.learn.loop.maxRowsTotal);
    expect(result.verification?.verified).toBe(true);
  });
});

/** The pair's rules with the label cut at `cut` (700 is right). */
function rulesOf(cut: number): LearnResult {
  const headers = ['תז', 'מספר לקוח', 'טלפון', 'שם', 'סכום'];
  const idsOf = ['id', 'customer', 'phone', 'name', 'amount'];
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: headers.map((header, i) => ({ id: idsOf[i]!, header, type: i === 3 ? ('text' as const) : ('integer' as const) })),
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
      columns: [...headers.map((header, i) => ({ header, from: idsOf[i]! })), { header: 'סוג', from: 'kind' }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
