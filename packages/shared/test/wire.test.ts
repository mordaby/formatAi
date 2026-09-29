import { describe, expect, it } from 'vitest';
import { LearnResultSchema, type LearnResult, type Rules } from '../src/rules/schema';
import { fromWire, learnResultWireJsonSchema, toWire } from '../src/rules/wire';

/** A LearnResult exercising every field wire.ts has to reshape: valueMaps.map,
 * expand.columnsToRows.labels, output.summaryRows[].cells and
 * transform.group.summaryRows[].cells (the fourth open dictionary this file's own
 * test below found, beyond the three LEARN_PROMPT §3 names). */
function richLearnResult(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'agent', header: 'Agent', type: 'idLike', required: true },
        { id: 'month', header: 'Month', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal', required: true },
        { id: 'jan', header: 'Jan', type: 'decimal' },
        { id: 'feb', header: 'Feb', type: 'decimal' },
      ],
      rowFilters: [{ column: 'agent', op: 'ne', value: '' }],
    },
    transform: {
      computed: [],
      valueMaps: [
        { column: 'month', map: { ינואר: 'JAN', פברואר: 'FEB' }, onMissing: 'flag' },
      ],
      sort: [{ column: 'agent', dir: 'asc' }],
      expand: {
        mode: 'columnsToRows',
        columns: ['jan', 'feb'],
        labelId: 'monthLabel',
        labels: { jan: 'January', feb: 'February' },
        valueId: 'monthValue',
        valueType: 'decimal',
        skipEmpty: true,
      },
      group: {
        by: 'agent',
        showDetailRows: true,
        summaryRows: [{ label: 'Agent total', cells: { Amount: 'sum', Count: 'count' } }],
      },
    },
    output: {
      sheetName: 'Report',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Agent', from: 'agent' },
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
        { header: 'Count', from: 'amount' },
      ],
      summaryRows: [{ label: 'Grand total', cells: { Amount: 'sum', Count: 'count' } }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** A second LearnResult covering the `fixedFanOut` expand mode (mutually exclusive
 * with `columnsToRows` on a single rules file, so it needs its own fixture). */
function fixedFanOutLearnResult(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [{ id: 'amount', header: 'Amount', type: 'decimal', required: true }],
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [],
      expand: {
        mode: 'fixedFanOut',
        rows: [
          { set: { side: { const: 'debit' }, signedAmount: { col: 'amount' } } },
          {
            set: {
              side: { const: 'credit' },
              signedAmount: { op: 'neg', arg: { col: 'amount' } },
            },
          },
        ],
      },
    },
    output: {
      sheetName: 'Ledger',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Side', from: 'side' },
        { header: 'Amount', from: 'signedAmount' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

describe('toWire / fromWire round trip', () => {
  it('round-trips valueMaps, columnsToRows labels, and summaryRows cells', () => {
    const original = richLearnResult();
    const wire = toWire(original);
    const back = fromWire(wire);
    expect(back).toEqual(original);
  });

  it('the wire form uses {key,value} pairs, not records, for every open dictionary', () => {
    const wire = toWire(richLearnResult());
    expect(wire.transform.valueMaps[0]!.map).toEqual([
      { key: 'ינואר', value: 'JAN' },
      { key: 'פברואר', value: 'FEB' },
    ]);
    expect(wire.transform.expand).toMatchObject({
      labels: [
        { key: 'jan', value: 'January' },
        { key: 'feb', value: 'February' },
      ],
    });
    expect(wire.output.summaryRows![0]!.cells).toEqual([
      { key: 'Amount', value: 'sum' },
      { key: 'Count', value: 'count' },
    ]);
    expect(wire.transform.group!.summaryRows![0]!.cells).toEqual([
      { key: 'Amount', value: 'sum' },
      { key: 'Count', value: 'count' },
    ]);
  });

  it('round-trips fixedFanOut.rows[].set (a Record<id, Expr>)', () => {
    const original = fixedFanOutLearnResult();
    const wire = toWire(original);
    expect(wire.transform.expand?.mode).toBe('fixedFanOut');
    const expand = wire.transform.expand as Extract<typeof wire.transform.expand, { mode: 'fixedFanOut' }>;
    expect(expand.rows[0]!.set).toEqual([
      { key: 'side', value: { const: 'debit' } },
      { key: 'signedAmount', value: { col: 'amount' } },
    ]);
    expect(fromWire(wire)).toEqual(original);
  });

  it('preserves extra fields (name/meta) through the generic, for a stored Rules object', () => {
    const rules: Rules = {
      ...richLearnResult(),
      name: 'My format',
      meta: { source: 'examplePair', status: 'verified' },
    };
    const wire = toWire(rules);
    expect(wire.name).toBe('My format');
    expect(wire.meta).toEqual({ source: 'examplePair', status: 'verified' });
    expect(fromWire(wire)).toEqual(rules);
  });

  it('every round-tripped result still validates against LearnResultSchema', () => {
    for (const rules of [richLearnResult(), fixedFanOutLearnResult()]) {
      const wire = toWire(rules);
      const back = fromWire(wire);
      const result = LearnResultSchema.safeParse(back);
      expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(true);
    }
  });

  it('fromWire is defensive: an already-a-record map (not wire pairs) passes through unchanged', () => {
    const malformed = {
      ...richLearnResult(),
      transform: { ...richLearnResult().transform, valueMaps: [{ column: 'month', map: { a: 'b' }, onMissing: 'flag' }] },
    };
    expect(() => fromWire(malformed)).not.toThrow();
    expect((fromWire(malformed) as typeof malformed).transform.valueMaps[0]!.map).toEqual({ a: 'b' });
  });

  it('fromWire never throws on garbage input', () => {
    expect(fromWire(null)).toBeNull();
    expect(fromWire(42)).toBe(42);
    expect(fromWire({})).toEqual({});
    expect(() => fromWire({ transform: { valueMaps: 'not an array' } })).not.toThrow();
  });
});

describe('learnResultWireJsonSchema', () => {
  const schema = learnResultWireJsonSchema();

  it('is valid, parseable JSON', () => {
    expect(JSON.parse(JSON.stringify(schema))).toBeTruthy();
  });

  it('requires exactly the LEARN_PROMPT §5 top-level keys', () => {
    expect(schema.required).toEqual([
      'schemaVersion',
      'input',
      'transform',
      'output',
      'validations',
      'unsupported',
      'assumptions',
    ]);
  });

  /** Every object node in the schema must be closed: either it has no `properties`
   * key at all (impossible in this schema, once every open dictionary is a
   * `{key,value}[]` array instead) or `additionalProperties: false`. Unlike
   * `jsonSchema.test.ts`'s equivalent check for the non-wire schema, this one makes
   * NO exemption for record-shaped nodes - the whole point of the wire schema is that
   * none exist. */
  function findOpenObjects(node: unknown, path: string, out: string[]): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => findOpenObjects(child, `${path}[${i}]`, out));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object' && obj.additionalProperties !== false) {
      out.push(path);
    }
    for (const key of Object.keys(obj)) {
      if (key === '$schema') continue;
      findOpenObjects(obj[key], `${path}.${key}`, out);
    }
  }

  it('has no open-dictionary objects anywhere (additionalProperties is always false)', () => {
    const offenders: string[] = [];
    findOpenObjects(schema, '$', offenders);
    expect(offenders).toEqual([]);
  });

  it('spells out Expr to a bounded depth ($defs chain of exactly limits.rules.maxExprDepth levels)', () => {
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs).toBeTruthy();
    const exprDefs = Object.keys(defs).filter((k) => k.startsWith('exprDepth'));
    expect(exprDefs).toHaveLength(8); // limits.rules.maxExprDepth
    expect(defs.exprDepth7).toBeTruthy();
    expect(defs.exprDepth8).toBeUndefined();
  });

  it('the Expr $defs chain only ever $refs a strictly lower level (never itself or a higher one)', () => {
    const defs = schema.$defs as Record<string, unknown>;
    function collectRefs(node: unknown, out: string[]): void {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) collectRefs(child, out);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj.$ref === 'string') out.push(obj.$ref);
      for (const value of Object.values(obj)) collectRefs(value, out);
    }
    for (let level = 1; level <= 7; level++) {
      const refs: string[] = [];
      collectRefs(defs[`exprDepth${level}`], refs);
      for (const ref of refs) {
        const match = /^#\/\$defs\/exprDepth(\d+)$/.exec(ref);
        expect(match, `unexpected $ref "${ref}" inside exprDepth${level}`).toBeTruthy();
        const refLevel = Number(match![1]);
        expect(refLevel, `exprDepth${level} must only $ref a lower level, found ${ref}`).toBeLessThan(level);
      }
    }
    // level 0 (the leaf) must not reference anything - it's the base case.
    const level0Refs: string[] = [];
    collectRefs(defs.exprDepth0, level0Refs);
    expect(level0Refs).toEqual([]);
  });
});
