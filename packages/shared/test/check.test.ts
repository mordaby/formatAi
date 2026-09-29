import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/rules/check';
import type { Expr, LearnResult } from '../src/rules/schema';

function baseRules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'a', header: 'A', type: 'text' },
        { id: 'b', header: 'B', type: 'decimal' },
      ],
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'A', from: 'a' },
        { header: 'B', from: 'b' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** Builds `neg(neg(...(const 1)))` with the given total nesting depth (a leaf alone is depth 1). */
function nestedNeg(depth: number): Expr {
  let e: Expr = { const: 1 };
  for (let i = 0; i < depth - 1; i++) {
    e = { op: 'neg', arg: e };
  }
  return e;
}

describe('checkRules', () => {
  it('returns no problems for a well-formed, minimal rules object', () => {
    expect(checkRules(baseRules())).toEqual([]);
  });

  it('finds a reference to an unknown column id', () => {
    const rules = baseRules();
    rules.output.columns.push({ header: 'C', from: 'doesNotExist' });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'output.columns[2].from' }),
    );
  });

  it('finds an id collision created by expand', () => {
    const rules = baseRules();
    rules.transform.expand = {
      mode: 'columnsToRows',
      columns: ['a'],
      // 'b' still exists after 'a' is removed by columnsToRows, so this collides.
      labelId: 'b',
      valueId: 'value',
      valueType: 'text',
      skipEmpty: false,
    };
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'duplicateId', path: 'transform.expand.labelId' }),
    );
  });

  it('accepts an expression at the maximum nesting depth (8)', () => {
    const rules = baseRules();
    rules.transform.computed.push({ id: 'c', type: 'decimal', expr: nestedNeg(8) });
    const problems = checkRules(rules);
    expect(problems.filter((p) => p.kind === 'depth')).toEqual([]);
  });

  it('finds an expression that nests one level past the maximum (9)', () => {
    const rules = baseRules();
    rules.transform.computed.push({ id: 'c', type: 'decimal', expr: nestedNeg(9) });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'depth', path: 'transform.computed[0].expr' }),
    );
  });

  it('lets later computed columns reference earlier computed ids', () => {
    const rules = baseRules();
    rules.transform.computed.push(
      { id: 'c1', type: 'decimal', expr: { col: 'b' } },
      { id: 'c2', type: 'decimal', expr: { op: 'neg', arg: { col: 'c1' } } },
    );
    expect(checkRules(rules)).toEqual([]);
  });

  it('flags a duplicate input column id', () => {
    const rules = baseRules();
    rules.input.columns.push({ id: 'a', header: 'A again', type: 'text' });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'duplicateId', path: 'input.columns[2].id' }),
    );
  });
});

// SPEC 8.14 / 21 (v3): functions, tables, lookup and param reference checks.
describe('checkRules: functions and tables (SPEC 8.14)', () => {
  it('accepts a top-level call to a declared function, checking arg count', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'double', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { op: 'mul', args: [{ param: 'x' }, { const: 2 }] } },
    ];
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'call', fn: 'double', args: [{ col: 'b' }] },
    });
    expect(checkRules(rules)).toEqual([]);
  });

  it('rejects a top-level call to an unknown function', () => {
    const rules = baseRules();
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'call', fn: 'doesNotExist', args: [] },
    });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.computed[0].expr' }),
    );
  });

  it('rejects a call with the wrong number of arguments', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'double', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'x' } },
    ];
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'call', fn: 'double', args: [{ col: 'b' }, { col: 'a' }] },
    });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'arity' }));
  });

  it('lets a function call another function defined above it', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'base', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'x' } },
      {
        name: 'doubled',
        params: [{ name: 'x', type: 'decimal' }],
        returns: 'decimal',
        body: { op: 'mul', args: [{ op: 'call', fn: 'base', args: [{ param: 'x' }] }, { const: 2 }] },
      },
    ];
    expect(checkRules(rules)).toEqual([]);
  });

  it('rejects a function calling a function defined below it (or itself)', () => {
    const rules = baseRules();
    rules.transform.functions = [
      {
        name: 'first',
        params: [{ name: 'x', type: 'decimal' }],
        returns: 'decimal',
        // calls "second", declared below - not allowed (SPEC 8.14: "only functions defined above it").
        body: { op: 'call', fn: 'second', args: [{ param: 'x' }] },
      },
      { name: 'second', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'x' } },
    ];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.functions[0].body' }),
    );
  });

  it('rejects "col" inside a function body', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'f', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { col: 'a' } },
    ];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.functions[0].body' }),
    );
  });

  it('rejects "param" outside a function body', () => {
    const rules = baseRules();
    rules.transform.computed.push({ id: 'c', type: 'decimal', expr: { param: 'x' } });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.computed[0].expr' }),
    );
  });

  it('rejects a param name not declared by the function', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'f', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { param: 'y' } },
    ];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.functions[0].body' }),
    );
  });

  it('flags a duplicate function name', () => {
    const rules = baseRules();
    rules.transform.functions = [
      { name: 'f', params: [], returns: 'decimal', body: { const: 1 } },
      { name: 'f', params: [], returns: 'decimal', body: { const: 2 } },
    ];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'duplicateId', path: 'transform.functions[1].name' }),
    );
  });

  it('accepts a lookup naming an existing table and column', () => {
    const rules = baseRules();
    rules.transform.tables = [
      { name: 'rates', columns: ['code', 'rate'], rows: [['A', 0.1], ['B', 0.2]] },
    ];
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'lookup', table: 'rates', key: { col: 'a' }, return: 'rate', onMissing: 'flag' },
    });
    expect(checkRules(rules)).toEqual([]);
  });

  it('rejects a lookup naming an unknown table', () => {
    const rules = baseRules();
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'lookup', table: 'doesNotExist', key: { col: 'a' }, return: 'rate', onMissing: 'flag' },
    });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.computed[0].expr' }),
    );
  });

  it('rejects a lookup whose "return" is not one of the table\'s columns', () => {
    const rules = baseRules();
    rules.transform.tables = [{ name: 'rates', columns: ['code', 'rate'], rows: [['A', 0.1]] }];
    rules.transform.computed.push({
      id: 'c',
      type: 'decimal',
      expr: { op: 'lookup', table: 'rates', key: { col: 'a' }, return: 'notAColumn', onMissing: 'flag' },
    });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'transform.computed[0].expr' }),
    );
  });

  it('flags duplicate column names within a table', () => {
    const rules = baseRules();
    rules.transform.tables = [{ name: 'rates', columns: ['code', 'code'], rows: [] }];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'duplicateId', path: 'transform.tables[0].columns[1]' }),
    );
  });

  it('flags a duplicate first-column key across table rows', () => {
    const rules = baseRules();
    rules.transform.tables = [
      {
        name: 'rates',
        columns: ['code', 'rate'],
        rows: [
          ['A', 0.1],
          ['A', 0.2],
        ],
      },
    ];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'duplicateId', path: 'transform.tables[0].rows[1][0]' }),
    );
  });
});

// SPEC 8.3: rowFilters' {expr} variant is checked like any other expression.
describe('checkRules: rowFilters {expr} (SPEC 8.3)', () => {
  it('accepts an {expr} rowFilter referencing existing input ids', () => {
    const rules = baseRules();
    rules.input.rowFilters = [{ expr: { op: 'gt', args: [{ col: 'b' }, { const: 0 }] } }];
    expect(checkRules(rules)).toEqual([]);
  });

  it('rejects an {expr} rowFilter referencing an unknown id', () => {
    const rules = baseRules();
    rules.input.rowFilters = [{ expr: { op: 'gt', args: [{ col: 'missing' }, { const: 0 }] } }];
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'input.rowFilters[0].expr[0]' }),
    );
  });
});

// SPEC 8.8: output validations name existing output headers, not input/computed ids.
describe('checkRules: validations "on" (SPEC 8.8)', () => {
  it('accepts an output validation naming an existing output header', () => {
    const rules = baseRules();
    rules.validations.push({ on: 'output', column: 'A', rule: 'required', severity: 'flag' });
    expect(checkRules(rules)).toEqual([]);
  });

  it('rejects an output validation naming an unknown output header', () => {
    const rules = baseRules();
    rules.validations.push({ on: 'output', column: 'NotAHeader', rule: 'required', severity: 'flag' });
    const problems = checkRules(rules);
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'reference', path: 'validations[0].column' }),
    );
  });
});
