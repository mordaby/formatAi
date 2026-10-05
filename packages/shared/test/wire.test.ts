import { describe, expect, it } from 'vitest';
import { LearnAlternativeSchema, LearnResultSchema, type LearnResult, type Rules } from '../src/rules/schema';
import { fromWire, learnResultWireJsonSchema, splitAlternatives, toWire, wireAnswerSchema } from '../src/rules/wire';

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

describe('readAs (SPEC 8.4a) is the user\'s own text and is not on the wire', () => {
  const withReadAs = (): LearnResult => {
    const r = richLearnResult();
    r.input.columns[2] = { ...r.input.columns[2]!, readAs: { 'N/A': '', none: '0' } };
    return r;
  };

  it('the rules schema takes it (and refuses an empty text as a key or a non-text value)', () => {
    expect(LearnResultSchema.safeParse(withReadAs()).success).toBe(true);
    const empty = withReadAs();
    empty.input.columns[2]!.readAs = { '': 'x' };
    expect(LearnResultSchema.safeParse(empty).success).toBe(false);
    const number = withReadAs();
    (number.input.columns[2] as { readAs: unknown }).readAs = { 'N/A': 0 };
    expect(LearnResultSchema.safeParse(number).success).toBe(false);
  });

  it('toWire leaves it out (the AI is never shown what the user typed), and never mutates the rules', () => {
    const rules = withReadAs();
    const before = JSON.stringify(rules);
    const wire = toWire(rules);
    expect(wire.input.columns.some((c) => 'readAs' in c)).toBe(false);
    expect(JSON.stringify(rules)).toBe(before);
    expect(wire.input.columns).toHaveLength(rules.input.columns.length);
  });

  it('fromWire drops one an answer carries anyway: the AI never writes it', () => {
    const answer = JSON.parse(JSON.stringify(toWire(richLearnResult()))) as { input: { columns: Record<string, unknown>[] } };
    answer.input.columns[2]!.readAs = { x: '' };
    const back = fromWire(answer) as LearnResult;
    expect(back.input.columns.some((c) => 'readAs' in c)).toBe(false);
    expect(LearnResultSchema.safeParse(back).success).toBe(true);
  });

  it('the schema sent to the provider has no readAs, and is the same one it was without the field', () => {
    expect(JSON.stringify(learnResultWireJsonSchema())).not.toContain('readAs');
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

  /** learn-v5: every one of SPEC 8.3's four Expr positions is a plain string (formula
   * text, `packages/engine/src/formula`) on the wire now, never a recursive/fixed-depth
   * tree - this is what shrank the schema from ~92,700 to a few thousand characters
   * (the old fixed-depth Expr chain, repeated `limits.rules.maxExprDepth` times, was
   * almost the entire size). */
  it('is well under 20,000 characters and carries no $defs chain (no recursion) and no open dicts', () => {
    const json = JSON.stringify(schema);
    expect(json.length).toBeLessThan(20_000);
    expect(schema.$defs).toBeUndefined();
    expect(json).not.toContain('$ref');
  });

  it('every Expr position (computed.expr, rowFilters.expr, functions.body) is a plain string', () => {
    const s = schema as {
      properties: {
        input: { properties: { rowFilters: { items: { anyOf: { properties?: Record<string, unknown> }[] } } } };
        transform: {
          properties: {
            computed: { items: { properties: { expr: { type: string } } } };
            functions: { items: { properties: { body: { type: string } } } };
          };
        };
      };
    };
    expect(s.properties.transform.properties.computed.items.properties.expr.type).toBe('string');
    expect(s.properties.transform.properties.functions.items.properties.body.type).toBe('string');
    const exprFilterBranch = s.properties.input.properties.rowFilters.items.anyOf.find((b) => b.properties && 'expr' in b.properties);
    expect((exprFilterBranch?.properties?.expr as { type: string } | undefined)?.type).toBe('string');
  });
});

describe('learn-v8: the optional `alternatives` of an answer (owner decision 2026-10-04)', () => {
  /** A wire answer (formula text) with one plain column and one computed one. */
  function wireAnswer(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'status', header: 'Status', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
      transform: { computed: [{ id: 'priority', type: 'text', expr: 'if(amount >= 5000, "Urgent", "Normal")' }], valueMaps: [], sort: [] },
      output: { sheetName: 'S', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Status', from: 'status' }, { header: 'Priority', from: 'priority' }] },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
  }
  const alternative = { outputColumn: 'Priority', from: 'priorityAlt', computed: [{ id: 'priorityAlt', type: 'text', expr: 'if(amount > 4435, "Urgent", "Normal")' }] };

  it('the wire schema accepts an answer with alternatives, and one without them (every learn-v7 answer stays valid)', () => {
    const schema = wireAnswerSchema();
    expect(schema.safeParse({ ...wireAnswer(), alternatives: [alternative] }).success).toBe(true);
    expect(schema.safeParse({ ...wireAnswer(), alternatives: [] }).success).toBe(true);
    expect(schema.safeParse(wireAnswer()).success).toBe(true);
    // A plain copy as the other rule: no computed column of its own.
    expect(schema.safeParse({ ...wireAnswer(), alternatives: [{ outputColumn: 'Priority', from: 'status', computed: [] }] }).success).toBe(true);
  });

  it('rejects an alternative of the wrong shape: a missing field, an unknown one, an expression tree instead of formula text', () => {
    const schema = wireAnswerSchema();
    const bad = (alt: unknown): boolean => schema.safeParse({ ...wireAnswer(), alternatives: [alt] }).success;
    expect(bad({ outputColumn: 'Priority', from: 'priorityAlt' })).toBe(false);
    expect(bad({ ...alternative, note: 'why' })).toBe(false);
    expect(bad({ ...alternative, computed: [{ id: 'priorityAlt', type: 'text', expr: { op: 'add', args: [] } }] })).toBe(false);
    expect(bad({ ...alternative, computed: [{ id: 'priorityAlt', type: 'money', expr: 'amount' }] })).toBe(false);
    expect(schema.safeParse({ ...wireAnswer(), alternatives: alternative }).success).toBe(false);
  });

  it('learn-v7 is sent the schema it was written for: no alternatives, and an answer with them does not fit it', () => {
    const v7 = wireAnswerSchema({ alternatives: false });
    expect(v7.safeParse(wireAnswer()).success).toBe(true);
    expect(v7.safeParse({ ...wireAnswer(), alternatives: [alternative] }).success).toBe(false);
    expect(JSON.stringify(learnResultWireJsonSchema({ alternatives: false }))).not.toContain('alternatives');
  });

  it('the JSON Schema: `alternatives` optional (not required), closed objects, formula text, still well under the size guard', () => {
    const schema = learnResultWireJsonSchema() as { properties: Record<string, { type?: string; items?: { properties: Record<string, unknown>; required: string[]; additionalProperties: unknown } }>; required: string[] };
    expect(schema.required).not.toContain('alternatives');
    const items = schema.properties.alternatives!.items!;
    expect(items.required).toEqual(['outputColumn', 'from', 'computed']);
    expect(items.additionalProperties).toBe(false);
    expect((items.properties.computed as { items: { properties: { expr: { type: string } } } }).items.properties.expr.type).toBe('string');
    const json = JSON.stringify(schema);
    expect(json).not.toContain('maxItems');
    expect(json.length).toBeLessThan(20_000);
    // What the alternatives added, in characters (the Windows CLI argument cap is ~32k).
    expect(json.length - JSON.stringify(learnResultWireJsonSchema({ alternatives: false })).length).toBeLessThan(1_000);
  });

  it('splitAlternatives takes them off the raw answer, so the answer is checked as before; the tree form is a LearnAlternative', () => {
    const { answer, alternatives } = splitAlternatives({ ...wireAnswer(), alternatives: [alternative] });
    expect(answer).toEqual(wireAnswer());
    expect(alternatives).toEqual([alternative]);
    expect(splitAlternatives(wireAnswer())).toEqual({ answer: wireAnswer(), alternatives: undefined });
    expect(splitAlternatives({ ...wireAnswer(), alternatives: 'x' }).alternatives).toBeUndefined();
    // An answer that still carries them is no LearnResult (the real gate is strict).
    expect(LearnResultSchema.safeParse({ ...(fromWire(wireAnswer()) as object), alternatives: [] }).success).toBe(false);
    const tree = { outputColumn: 'Priority', from: 'p2', computed: [{ id: 'p2', type: 'text', expr: { col: 'status' } }] };
    expect(LearnAlternativeSchema.safeParse(tree).success).toBe(true);
    expect(LearnAlternativeSchema.safeParse({ ...tree, computed: [{ id: '', type: 'text', expr: { col: 'status' } }] }).success).toBe(false);
  });
});
