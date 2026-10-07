// Engine audit (2026-10-07), fix 2: a completion call's constants (`complete.fixed`) were masked by their own SHAPE (`maskRules`): digits
// longer than 9 and text with no letter were sent real - "0501234567", "050-1234567" and "4111 1111 1111 1111" came back unchanged while
// the samples masked them. They feed `complete.fixed`, the copy code restores an answer from, and the fixed lock. Now each constant is
// masked the way its COLUMN is (the column classification, `maskFixedRules`), and lookup tables and value maps go with their shape only:
// their entries are data code filled from every row, and nothing filled is ever sent.
import { fromWire, LearnResultSchema, type Expr, type LearnPayload, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { formulaRulesFromWire } from '../../../src/formula';
import { learnFromExamples, type LearnCallResult } from '../../../src/learn/flow';
import { createMasker, maskRules, unmaskRules } from '../../../src/learn/mask';
import { classifyColumns } from '../../../src/learn/classify';
import { maskFixedRules } from '../../../src/learn/maskFixed';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';
import { mixedPair, xlsxBytesOf } from '../v5fixtures';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);
const PROBES = ['0501234567', '050-1234567', '4111 1111 1111 1111'];

describe('maskRules (no example to say the column): every constant is masked', () => {
  it('long digits, digits with separators and a card number are masked, and come back', () => {
    const m = createMasker(key('probe'));
    const rules = { input: { rowFilters: PROBES.map((value) => ({ column: 'c', op: 'eq', value })) } };
    const masked = maskRules(rules, m);
    for (const [i, real] of PROBES.entries()) {
      const fake = masked.input.rowFilters[i]!.value;
      expect(fake).not.toBe(real);
      expect(fake.replace(/\d/g, '9')).toBe(real.replace(/\d/g, '9')); // the same shape
    }
    expect(unmaskRules(masked, m)).toEqual(rules);
  });
});

// Phone (an identifier by its name), Name (text), Amount (a measure), Status (a category: an external classification code confirmed).
const STATUS = ['Active', 'Closed'];
function pair(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Phone', 'Name', 'Amount', 'Status']];
  const output: V[][] = [['Phone', 'Name', 'Size', 'Status']];
  for (let i = 0; i < 12; i++) {
    const phone = `05${i % 9}-${String(2345671 + i * 1013)}`;
    const amount = 200 + i * 150;
    input.push([phone, `Person ${'abcdefghijkl'[i]}`, amount, STATUS[i % 2]!]);
    output.push([phone, `Person ${'abcdefghijkl'[i]}`, amount > 1000 ? 'Big' : 'Small', STATUS[i % 2]!]);
  }
  return { input, output };
}

const c = (v: string | number): Expr => ({ const: v });
const col = (id: string): Expr => ({ col: id });
const RULES: LearnResult = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'phone', header: 'Phone', type: 'text' },
      { id: 'name', header: 'Name', type: 'text' },
      { id: 'amount', header: 'Amount', type: 'integer' },
      { id: 'status', header: 'Status', type: 'text' },
    ],
    rowFilters: [
      { column: 'phone', op: 'ne', value: '0501234567' },
      { column: 'status', op: 'ne', value: 'Active' },
      { column: 'amount', op: 'ne', value: '1000' },
    ],
  },
  transform: {
    computed: [
      { id: 'size', type: 'text', expr: { op: 'if', cond: { op: 'gt', args: [col('amount'), c(1000)] }, then: c('Big'), else: c('Small') } },
      { id: 'flag', type: 'text', expr: { op: 'if', cond: { op: 'startsWith', arg: col('phone'), text: '050-123' }, then: c('x'), else: { op: 'if', cond: { op: 'eq', args: [col('status'), c('Closed')] }, then: c('y'), else: c('z') } } },
    ],
    valueMaps: [],
    sort: [],
  },
  output: {
    sheetName: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Phone', from: 'phone' },
      { header: 'Name', from: 'name' },
      { header: 'Size', from: 'size' },
      { header: 'Status', from: 'status' },
    ],
  },
  validations: [{ column: 'phone', rule: 'oneOf', values: ['050-1234567'], severity: 'flag' }],
  unsupported: [],
  assumptions: [],
};

describe('maskFixedRules: each constant masked the way its column is', () => {
  const { input, output } = pair();
  const a = analyzeOk(xlsx(input), xlsx(output), { columnHints: { Status: 'category' } });
  const m = createMasker(key('by-class'));
  const masked = maskFixedRules(RULES, m, a);
  const filters = masked.input.rowFilters as { value: string }[];

  it('the setup: an identifier, text, a measure and a category', () => {
    expect(classifyColumns(a).input).toEqual(['identifier', 'text', 'measure', 'category']);
  });

  it('a phone constant is masked like the phone cells (an identifier), whatever its shape', () => {
    expect(filters[0]!.value).toBe(m.maskIdLike('0501234567'));
    expect(filters[0]!.value).not.toBe('0501234567');
    const flag = masked.transform.computed[1]!.expr as { cond: { text: string } };
    expect(flag.cond.text).toBe(m.maskIdLike('050-123'));
    expect((masked.validations[0] as { values: string[] }).values).toEqual([m.maskIdLike('050-1234567')]);
  });

  it('a category\'s and a measure\'s constants are sent real, like their cells', () => {
    expect(filters[1]!.value).toBe('Active');
    expect(filters[2]!.value).toBe('1000');
    const flag = masked.transform.computed[1]!.expr as { else: { cond: { args: [Expr, { const: string }] } } };
    expect(flag.else.cond.args[1].const).toBe('Closed');
  });

  it('a branch\'s value is masked like the output column it goes to (Size: text)', () => {
    const size = masked.transform.computed[0]!.expr as { then: { const: string }; else: { const: string } };
    expect(size.then.const).toBe(m.maskText('Big'));
    expect(size.else.const).toBe(m.maskText('Small'));
    expect(size.then.const).not.toBe('Big');
  });

  it('what was masked comes back exactly', () => {
    expect(unmaskRules(masked, m)).toEqual(RULES);
  });
});

describe('completion mode: lookup tables and value maps go with their shape only', () => {
  const { input, output } = pair();
  const a = analyzeOk(xlsx(input), xlsx(output));
  const withLists: LearnResult = {
    ...RULES,
    input: { ...RULES.input, rowFilters: [] },
    transform: {
      ...RULES.transform,
      computed: [...RULES.transform.computed, { id: 'tier', type: 'text', expr: { op: 'lookup', table: 'tiers', key: col('name'), return: 'tier', onMissing: 'empty' } }],
      valueMaps: [{ column: 'status', map: { Active: 'On', Closed: 'Off' }, onMissing: 'keep' }],
      tables: [{ name: 'tiers', columns: ['name', 'tier'], rows: [['Person a', 'Gold'], ['Person b', 'Silver'], ['Person c', 'Bronze']] }],
    },
  };
  for (const masking of [true, false]) {
    it(`no entry is sent (masking ${masking ? 'on' : 'off'})`, () => {
      const { payload } = buildPayload(a, preflight(a, 'paid'), { ...(masking ? { masker: createMasker(key('lists')) } : {}), complete: { fixedRules: withLists, columns: [2], parts: [] } });
      const fixed = payload.complete!.fixed as { transform: { tables: { name: string; columns: string[]; rows: unknown[] }[]; valueMaps: { column: string; map: unknown[] }[] } };
      expect(fixed.transform.tables).toEqual([{ name: 'tiers', columns: ['name', 'tier'], rows: [] }]);
      expect(fixed.transform.valueMaps).toEqual([{ column: 'status', map: [], onMissing: 'keep' }]);
      const json = JSON.stringify(payload.complete);
      for (const word of ['Gold', 'Silver', 'Bronze', '"On"', '"Off"']) expect(json).not.toContain(word);
    });
  }
});

describe('completion mode end to end: the user\'s filled table is put back on the answer', () => {
  it('the AI step sees the table with no rows; the rules kept have every row of it, and the answer matches', async () => {
    const p = mixedPair();
    const inBytes = await xlsxBytesOf(p.input);
    const outBytes = await xlsxBytesOf(p.output);
    const files = { input: { bytes: inBytes, name: 'in.xlsx' }, output: { bytes: outBytes, name: 'out.xlsx' } };
    const partial = await learnFromExamples({ ...files, masking: false, tier: 'paid', ai: 'notAllowed', callLearn: async () => { throw new Error('no AI step'); } });
    const rules = partial.rules!;
    const ref = rules.input.columns.find((x) => x.header === 'Ref')!.id;
    // The user's rules: Warehouse from a lookup table code filled from every row (20 entries keyed on Ref).
    const rows = p.input.slice(1).map((r, i) => [r[0] as string, p.output[i + 1]![4] as string]);
    const fixedRules: LearnResult = {
      ...rules,
      transform: { ...rules.transform, computed: [...rules.transform.computed, { id: 'wh', type: 'text', expr: { op: 'lookup', table: 'warehouses', key: col(ref), return: 'warehouse', onMissing: 'flag' } }], tables: [{ name: 'warehouses', columns: ['ref', 'warehouse'], rows }] },
      output: { ...rules.output, columns: rules.output.columns.map((x) => (x.header === 'Warehouse' ? { ...x, from: 'wh' } : x)) },
    };
    const seen: LearnPayload[] = [];
    const callLearn = async (payload: LearnPayload): Promise<LearnCallResult> => {
      seen.push(payload);
      const f = LearnResultSchema.parse(formulaRulesFromWire(fromWire(payload.complete!.fixed)).rules);
      const group = f.input.columns.find((x) => x.header === 'Group')?.id ?? 'group';
      const columns = f.input.columns.some((x) => x.header === 'Group') ? f.input.columns : [...f.input.columns, { id: group, header: 'Group', type: 'text' as const }];
      const answer: LearnResult = {
        ...f,
        input: { ...f.input, columns },
        transform: { ...f.transform, computed: [...f.transform.computed, { id: 'labelOut', type: 'text', expr: { op: 'if', cond: { op: 'eq', args: [col(ref), c('R-1049')] }, then: c('Special'), else: col(group) } }] },
        output: { ...f.output, columns: f.output.columns.map((x) => (x.header === 'Label' ? { ...x, from: 'labelOut' } : x)) },
      };
      return { rules: answer, problems: [], calls: [] };
    };
    for (const masking of [false, true]) {
      seen.length = 0;
      const r = await learnFromExamples({ ...files, masking, ...(masking ? { key: key('e2e') } : {}), tier: 'paid', complete: { fixedRules, columns: [3], parts: [] }, callLearn });
      const sent = seen[0]!.complete!.fixed as { transform: { tables: { rows: unknown[] }[] } };
      expect(sent.transform.tables[0]!.rows).toEqual([]);
      expect(JSON.stringify(seen[0]!.complete)).not.toContain(rows[0]![1]!);
      expect(r.completion).toMatchObject({ fixedProblems: [], matches: true });
      expect(r.rules!.transform.tables).toEqual(fixedRules.transform.tables);
      expect(r.verification?.verified).toBe(true);
    }
  });
});
