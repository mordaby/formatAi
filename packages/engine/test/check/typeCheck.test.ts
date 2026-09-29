// SPEC 9.2 layer 3 / SPEC 21: static type checking of expressions, filters and
// function bodies against declared column types and the operation signatures (8.3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema, type LearnResult } from '@formatai/shared';
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

describe('typeCheck: golden rules files', () => {
  const caseNames = fs.readdirSync(goldenCasesDir).filter((name) => fs.statSync(path.join(goldenCasesDir, name)).isDirectory());

  it.each(caseNames)('%s type-checks clean', (name) => {
    const json = JSON.parse(fs.readFileSync(path.join(goldenCasesDir, name, 'rules.json'), 'utf8')) as unknown;
    const rules = RulesSchema.parse(json);
    expect(typeCheck(rules)).toEqual([]);
  });
});
