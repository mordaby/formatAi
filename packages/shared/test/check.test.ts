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

  it('accepts an expression at the maximum nesting depth (6)', () => {
    const rules = baseRules();
    rules.transform.computed.push({ id: 'c', type: 'decimal', expr: nestedNeg(6) });
    const problems = checkRules(rules);
    expect(problems.filter((p) => p.kind === 'depth')).toEqual([]);
  });

  it('finds an expression that nests one level past the maximum (7)', () => {
    const rules = baseRules();
    rules.transform.computed.push({ id: 'c', type: 'decimal', expr: nestedNeg(7) });
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
