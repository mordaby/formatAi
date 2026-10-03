// SPEC 9.2 layer 3 / SPEC 21: static type checking of expressions, filters and
// function bodies against declared column types and the operation signatures (8.3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema, type Expr, type LearnResult } from '@formatai/shared';
import { typeCheck } from '../../src/check/typeCheck';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenCasesDir = path.join(here, '..', 'golden', 'cases');

function baseRules(overrides: Partial<LearnResult> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [] },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [] },
    validations: [],
    unsupported: [],
    assumptions: [],
    ...overrides,
  };
}

function findProblem<T extends { path?: string }>(problems: T[], path: string): T | undefined {
  return problems.find((p) => p.path === path);
}

describe('typeCheck: widenings accepted (SPEC 8.3)', () => {
  it('integer -> decimal: a computed column declared decimal may hold an integer column', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'i', header: 'I', type: 'integer' }] },
      transform: {
        computed: [{ id: 'c', type: 'decimal', expr: { col: 'i' } }],
        valueMaps: [],
        sort: [],
      },
    });
    expect(typeCheck(rules)).toEqual([]);
  });

  it('idLike -> text: a computed column declared text may hold an idLike column', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'p', header: 'P', type: 'idLike' }] },
      transform: {
        computed: [{ id: 'c', type: 'text', expr: { col: 'p' } }],
        valueMaps: [],
        sort: [],
      },
    });
    expect(typeCheck(rules)).toEqual([]);
  });

  it('currency/percent input columns normalize to decimal for expressions', () => {
    const rules = baseRules({
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'amt', header: 'Amount', type: 'currency' },
          { id: 'rate', header: 'Rate', type: 'percent' },
        ],
      },
      transform: {
        computed: [{ id: 'c', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amt' }, { col: 'rate' }] } }],
        valueMaps: [],
        sort: [],
      },
    });
    expect(typeCheck(rules)).toEqual([]);
  });
});

describe('typeCheck: mismatches rejected with precise paths', () => {
  it('text into mul', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'A', type: 'text' }] },
      transform: {
        computed: [{ id: 'c', type: 'decimal', expr: { op: 'mul', args: [{ col: 'a' }, { const: 2 }] } }],
        valueMaps: [],
        sort: [],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'transform.computed[0].expr.args[0]');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected decimal, got text; use toNumber');
  });

  it('date into add', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'd', header: 'D', type: 'date' }] },
      transform: {
        computed: [{ id: 'c', type: 'decimal', expr: { op: 'add', args: [{ col: 'd' }, { const: 1 }] } }],
        valueMaps: [],
        sort: [],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'transform.computed[0].expr.args[0]');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected decimal, got date');
  });

  it('boolean filter required (rowFilters.expr must be boolean)', () => {
    const rules = baseRules({
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [{ id: 'a', header: 'A', type: 'text' }],
        rowFilters: [{ expr: { col: 'a' } }],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'input.rowFilters[0].expr');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected boolean, got text');
  });

  it('function body vs returns', () => {
    const rules = baseRules({
      transform: {
        computed: [],
        valueMaps: [],
        sort: [],
        functions: [{ name: 'f', params: [{ name: 'x', type: 'decimal' }], returns: 'integer', body: { param: 'x' } }],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'transform.functions[0].body');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected integer, got decimal');
  });

  it('lookup key mismatch', () => {
    const rules = baseRules({
      transform: {
        computed: [
          {
            id: 'c',
            type: 'decimal',
            expr: { op: 'lookup', table: 't', key: { const: 5 }, return: 'val', onMissing: 'flag' },
          },
        ],
        valueMaps: [],
        sort: [],
        tables: [{ name: 't', columns: ['code', 'val'], rows: [['A', 1], ['B', 2]] }],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'transform.computed[0].expr.key');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected text (the key type of table "t"), got integer');
  });

  it('computed declared type mismatch', () => {
    const rules = baseRules({
      transform: {
        computed: [{ id: 'c', type: 'text', expr: { op: 'add', args: [{ const: 1 }, { const: 2 }] } }],
        valueMaps: [],
        sort: [],
      },
    });
    const problems = typeCheck(rules);
    const p = findProblem(problems, 'transform.computed[0].expr');
    expect(p).toBeDefined();
    expect(p?.message).toBe('expected text, got integer; use toText');
  });
});

describe('typeCheck: expand-created ids (SPEC 8.5)', () => {
  it('columnsToRows: labelId is text, valueId is the declared valueType', () => {
    const rules = baseRules({
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'jan', header: 'Jan', type: 'decimal' },
          { id: 'feb', header: 'Feb', type: 'decimal' },
        ],
      },
      transform: {
        expand: { mode: 'columnsToRows', columns: ['jan', 'feb'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true },
        computed: [{ id: 'label', type: 'text', expr: { col: 'month' } }],
        valueMaps: [],
        sort: [],
      },
    });
    expect(typeCheck(rules)).toEqual([]);
  });

  it('splitCell: partId is text, indexId/countId are integer', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'products', header: 'Products', type: 'text' }] },
      transform: {
        expand: { mode: 'splitCell', column: 'products', separator: ';', trim: true, partId: 'part', indexId: 'idx', countId: 'count', skipEmpty: true },
        computed: [
          { id: 'p', type: 'text', expr: { col: 'part' } },
          { id: 'i', type: 'integer', expr: { col: 'idx' } },
          { id: 'n', type: 'integer', expr: { col: 'count' } },
        ],
        valueMaps: [],
        sort: [],
      },
    });
    expect(typeCheck(rules)).toEqual([]);
  });

  it('fixedFanOut: an id set to incompatible types across rows is a type problem', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'amount', header: 'Amount', type: 'decimal' }] },
      transform: {
        expand: {
          mode: 'fixedFanOut',
          rows: [{ set: { side: { const: 'debit' } } }, { set: { side: { col: 'amount' } } }],
        },
        computed: [],
        valueMaps: [],
        sort: [],
      },
    });
    const problems = typeCheck(rules);
    expect(problems.some((p) => p.path === 'transform.expand.rows[].set.side')).toBe(true);
  });
});

describe('typeCheck: opts.inputProfile / opts.outputTypes', () => {
  it('flags a declared input type that disagrees with the profile', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'Amount', type: 'text' }] },
    });
    const problems = typeCheck(rules, { inputProfile: [{ header: 'Amount', type: 'decimal' }] });
    const p = findProblem(problems, 'input.columns[0].type');
    expect(p).toBeDefined();
  });

  it('does not flag a matching profile type', () => {
    const rules = baseRules({
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'Amount', type: 'decimal' }] },
    });
    expect(typeCheck(rules, { inputProfile: [{ header: 'Amount', type: 'decimal' }] })).toEqual([]);
  });

  it('flags an output column whose source type does not fit the declared output type', () => {
    const rules = baseRules({
      transform: {
        computed: [{ id: 'c', type: 'text', expr: { const: 'x' } }],
        valueMaps: [],
        sort: [],
      },
      output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Total', from: 'c' }] },
    });
    const problems = typeCheck(rules, { outputTypes: { Total: 'decimal' } });
    expect(findProblem(problems, 'output.columns[0]')).toBeDefined();
  });
});

describe('typeCheck: a summary output column has the type its agg gives (SPEC 8.6)', () => {
  /** Group by `dept`, one row per group (showDetailRows false); the output columns are `cols`. */
  function summaryOutput(cols: { header: string; from: string; agg?: 'sum' | 'count' | 'min' | 'max' | 'average' | 'first' | 'last' }[], showDetailRows = false): LearnResult {
    return baseRules({
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'poNo', header: 'PO No', type: 'idLike' },
          { id: 'dept', header: 'Dept', type: 'text' },
          { id: 'qty', header: 'Qty', type: 'integer' },
          { id: 'amount', header: 'Amount', type: 'decimal' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [], group: { by: 'dept', showDetailRows } },
      output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: cols },
    });
  }
  const types = { Orders: 'integer', 'Total Qty': 'integer', Total: 'decimal', Average: 'decimal', Latest: 'text' };

  it('a count is an integer whatever it counts: the count of an id or text column fits an integer output column', () => {
    const rules = summaryOutput([{ header: 'Orders', from: 'poNo', agg: 'count' }]);
    expect(typeCheck(rules, { outputTypes: types })).toEqual([]);
    expect(typeCheck(summaryOutput([{ header: 'Orders', from: 'dept', agg: 'count' }]), { outputTypes: types })).toEqual([]);
  });

  it('a sum and an average are numbers: they fit a numeric output column, and not a text one', () => {
    const ok = summaryOutput([
      { header: 'Total Qty', from: 'qty', agg: 'sum' },
      { header: 'Total', from: 'amount', agg: 'sum' },
      { header: 'Average', from: 'amount', agg: 'average' },
    ]);
    expect(typeCheck(ok, { outputTypes: types })).toEqual([]);
    const bad = summaryOutput([
      { header: 'Latest', from: 'qty', agg: 'sum' },
      { header: 'Latest', from: 'qty', agg: 'count' },
    ]);
    expect(typeCheck(bad, { outputTypes: types }).map((p) => p.path)).toEqual(['output.columns[0]', 'output.columns[1]']);
  });

  it('first, last, min and max keep the type of what they read', () => {
    expect(typeCheck(summaryOutput([{ header: 'Latest', from: 'dept', agg: 'first' }]), { outputTypes: types })).toEqual([]);
    expect(typeCheck(summaryOutput([{ header: 'Total', from: 'dept', agg: 'last' }]), { outputTypes: types }).map((p) => p.path)).toEqual(['output.columns[0]']);
  });

  it('a column with no agg is still the type of what it reads (a text column is no integer)', () => {
    expect(typeCheck(summaryOutput([{ header: 'Orders', from: 'poNo' }]), { outputTypes: types }).map((p) => p.path)).toEqual(['output.columns[0]']);
  });

  it('without a summary output the engine ignores agg, so it does not change the type: no group, or a group that shows its detail rows', () => {
    const detail = summaryOutput([{ header: 'Orders', from: 'poNo', agg: 'count' }], true);
    expect(typeCheck(detail, { outputTypes: types }).map((p) => p.path)).toEqual(['output.columns[0]']);
    const noGroup = { ...detail, transform: { ...detail.transform, group: undefined } } as LearnResult;
    expect(typeCheck(noGroup, { outputTypes: types }).map((p) => p.path)).toEqual(['output.columns[0]']);
  });
});

describe('typeCheck: summary rows (SPEC 8.12 v4)', () => {
  function summaryRules(cells: Record<string, 'sum' | 'count' | 'min' | 'max' | 'average' | 'first' | 'last'>): LearnResult {
    return baseRules({
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'name', header: 'Name', type: 'text' },
          { id: 'qty', header: 'Qty', type: 'decimal' },
          { id: 'd', header: 'Date', type: 'date' },
        ],
      },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Name', from: 'name' },
          { header: 'Qty', from: 'qty' },
          { header: 'Date', from: 'd' },
        ],
        summaryRows: [{ cells }],
      },
    });
  }

  it('sum/average on a numeric column: no problem', () => {
    expect(typeCheck(summaryRules({ Qty: 'sum' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Qty: 'average' }))).toEqual([]);
  });

  it('sum/average on a text or date column: a type problem', () => {
    for (const [header, agg] of [
      ['Name', 'sum'],
      ['Name', 'average'],
      ['Date', 'sum'],
    ] as const) {
      const problems = typeCheck(summaryRules({ [header]: agg }));
      const p = findProblem(problems, `output.summaryRows[0].cells.${header}`);
      expect(p, `${agg} on ${header}`).toBeDefined();
    }
  });

  it('min/max on a numeric or date column: no problem', () => {
    expect(typeCheck(summaryRules({ Qty: 'min' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Qty: 'max' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Date: 'min' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Date: 'max' }))).toEqual([]);
  });

  it('min/max on a text column: a type problem', () => {
    const problems = typeCheck(summaryRules({ Name: 'max' }));
    expect(findProblem(problems, 'output.summaryRows[0].cells.Name')).toBeDefined();
  });

  it('count/first/last accept any type', () => {
    expect(typeCheck(summaryRules({ Name: 'count' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Name: 'first' }))).toEqual([]);
    expect(typeCheck(summaryRules({ Name: 'last' }))).toEqual([]);
  });

  it('the same checks apply to transform.group.summaryRows', () => {
    const rules = summaryRules({});
    rules.output.summaryRows = [];
    rules.transform.group = { by: 'name', showDetailRows: true, summaryRows: [{ cells: { Name: 'max' } }] };
    const problems = typeCheck(rules);
    expect(findProblem(problems, 'transform.group.summaryRows[0].cells.Name')).toBeDefined();
  });
});

describe('typeCheck: golden rules files', () => {
  const caseNames = fs.readdirSync(goldenCasesDir).filter((name) => fs.statSync(path.join(goldenCasesDir, name)).isDirectory());

  it.each(caseNames)('%s type-checks clean', (name) => {
    const json = JSON.parse(fs.readFileSync(path.join(goldenCasesDir, name, 'rules.json'), 'utf8')) as unknown;
    const rules = RulesSchema.parse(json);
    expect(typeCheck(rules)).toEqual([]);
  });
});

describe('typeCheck: date and text operations added after learn-v6', () => {
  const columns: LearnResult['input']['columns'] = [
    { id: 'txt', header: 'Txt', type: 'text' },
    { id: 'code', header: 'Code', type: 'idLike' },
    { id: 'when', header: 'When', type: 'date' },
    { id: 'year', header: 'Year', type: 'integer' },
    { id: 'month', header: 'Month', type: 'decimal' },
    { id: 'day', header: 'Day', type: 'integer' },
  ];
  /** One computed column `c` of the given declared type, over the columns above. */
  const check = (type: LearnResult['transform']['computed'][number]['type'], expr: Expr) =>
    typeCheck(
      baseRules({
        input: { sheet: { pick: 'first' }, headerRow: 'auto', columns },
        transform: { computed: [{ id: 'c', type, expr }], valueMaps: [], sort: [] },
      }),
    );

  it('each op has its documented result type', () => {
    expect(check('integer', { op: 'weekday', arg: { col: 'when' } })).toEqual([]);
    expect(check('date', { op: 'makeDate', args: [{ col: 'year' }, { col: 'month' }, { col: 'day' }] })).toEqual([]);
    expect(check('date', { op: 'toDate', arg: { col: 'txt' }, format: 'D MMMM YYYY' })).toEqual([]);
    expect(check('date', { op: 'dateLiteral', value: '2026-01-31' })).toEqual([]);
    expect(check('text', { op: 'keepChars', arg: { col: 'txt' }, chars: 'digits' })).toEqual([]);
    expect(check('text', { op: 'titleCase', arg: { col: 'txt' } })).toEqual([]);
    expect(check('integer', { op: 'find', arg: { col: 'txt' }, search: '-' })).toEqual([]);
  });

  it('the results compose with the existing ops', () => {
    // makeDate -> weekday; toDate -> dateAdd; date literal into dateDiff; find into a comparison; idLike into a text op.
    expect(check('integer', { op: 'weekday', arg: { op: 'makeDate', args: [{ col: 'year' }, { const: 1 }, { const: 1 }] } })).toEqual([]);
    expect(check('date', { op: 'dateAdd', arg: { op: 'toDate', arg: { col: 'txt' }, format: 'DD/MM/YYYY' }, days: 30 })).toEqual([]);
    expect(check('integer', { op: 'dateDiff', args: [{ col: 'when' }, { op: 'dateLiteral', value: '2026-12-31' }], unit: 'days' })).toEqual([]);
    expect(check('boolean', { op: 'gt', args: [{ op: 'find', arg: { col: 'txt' }, search: '@' }, { const: 0 }] })).toEqual([]);
    expect(check('boolean', { op: 'lt', args: [{ col: 'when' }, { op: 'dateLiteral', value: '2026-06-01' }] })).toEqual([]);
    expect(check('text', { op: 'titleCase', arg: { col: 'code' } })).toEqual([]);
  });

  it('a date op is a date: it does not fit a text or number column, and needs toText', () => {
    const p = check('text', { op: 'makeDate', args: [{ col: 'year' }, { col: 'month' }, { col: 'day' }] });
    expect(p).toEqual([{ kind: 'type', path: 'transform.computed[0].expr', message: 'expected text, got date; use toText' }]);
    expect(check('decimal', { op: 'weekday', arg: { col: 'when' } })).toEqual([]); // integer widens to decimal
    expect(check('integer', { op: 'find', arg: { col: 'txt' }, search: 'x' })).toEqual([]);
  });

  it('rejects the wrong argument types, with precise paths and repair hints', () => {
    expect(check('integer', { op: 'weekday', arg: { col: 'txt' } })).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr.arg', message: 'expected date, got text' },
    ]);
    expect(check('date', { op: 'toDate', arg: { col: 'when' }, format: 'DD/MM/YYYY' })).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr.arg', message: 'expected text, got date; use toText' },
    ]);
    expect(check('date', { op: 'makeDate', args: [{ col: 'txt' }, { col: 'month' }, { col: 'day' }] })).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr.args[0]', message: 'expected decimal, got text; use toNumber' },
    ]);
    expect(check('text', { op: 'keepChars', arg: { col: 'year' }, chars: 'digits' })).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr.arg', message: 'expected text, got integer; use toText' },
    ]);
    expect(check('text', { op: 'titleCase', arg: { col: 'when' } })).toHaveLength(1);
    expect(check('integer', { op: 'find', arg: { col: 'month' }, search: '1' })).toHaveLength(1);
  });

  it('text where a date is declared is still an error: only makeDate / toDate / date() build a date', () => {
    expect(check('date', { col: 'txt' })).toEqual([
      { kind: 'type', path: 'transform.computed[0].expr', message: 'expected date, got text' },
    ]);
    expect(check('date', { op: 'concat', args: [{ col: 'txt' }, { const: '-01' }] })).toHaveLength(1);
    expect(check('integer', { op: 'dateDiff', args: [{ col: 'when' }, { const: '2026-12-31' }], unit: 'days' })).toHaveLength(1);
  });
});
