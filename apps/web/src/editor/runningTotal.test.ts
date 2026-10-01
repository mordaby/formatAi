// The one across-row option the editor offers: "Running total" in "How is it made?" (the owner's decision: every other window function is
// written in Advanced). Build, read back, round trip to the formula text, refusals, and what an edit must not lose.
import { checkLimits, typeCheck } from '@formatai/engine';
import { checkRules, RulesSchema, type Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { advancedJsonOf, applyEdit, createEditorState, parseAdvancedJson, readColumnMethod, sourceOptions, undo, redo, type ColumnMethod, type EditAction, type EditorState, type EditProblem } from './model';
import { ordersRules } from './testkit';
import { methodSources } from './columnMethod';

// Output columns of the orders report: 0 Item, 1 Supplier, 2 Qty, 3 Total, 4 Shipped, 5 Remarks (nothing fills it).
const REMARKS = 5;
const start = (rules: Rules = ordersRules()): EditorState => createEditorState(rules);

function ok(state: EditorState, action: EditAction): EditorState {
  const out = applyEdit(state, action);
  if (!out.result.ok) throw new Error(`${action.type} was refused: ${JSON.stringify(out.result.problems)}`);
  return out.state;
}

function refused(state: EditorState, action: EditAction): EditProblem[] {
  const out = applyEdit(state, action);
  if (out.result.ok) throw new Error(`${action.type} was accepted, expected problems`);
  expect(out.state).toBe(state);
  return out.result.problems;
}

function expectValid(rules: Rules): void {
  expect(RulesSchema.safeParse(rules).success).toBe(true);
  expect(checkRules(rules)).toEqual([]);
  expect(typeCheck(rules)).toEqual([]);
  expect(checkLimits(rules, 'paid')).toEqual([]);
}

const set = (index: number, method: ColumnMethod): EditAction => ({ type: 'setColumnMethod', index, method });
const computedFor = (s: EditorState, index: number) => s.rules.transform.computed.find((c) => c.id === s.rules.output.columns[index]!.from);

describe('Running total: build', () => {
  it('adds up a column in file order: a window column typed from its source', () => {
    const s = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'qty', orderBy: 'file' }));
    expectValid(s.rules as Rules);
    expect(computedFor(s, REMARKS)).toMatchObject({ id: 'running1', type: 'integer', expr: { op: 'window', fn: 'runningSum', arg: { col: 'qty' } } });
    expect(computedFor(s, REMARKS)!.expr).toEqual({ op: 'window', fn: 'runningSum', arg: { col: 'qty' } }); // no by:, no order:
  });

  it('a decimal column gives a decimal total', () => {
    const s = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'price', orderBy: 'file' }));
    expect(computedFor(s, REMARKS)!.type).toBe('decimal');
  });

  it('start again for each value of a column, in the order of a column, either direction', () => {
    const asc = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'price', groupBy: 'supplier', orderBy: { column: 'shipped', dir: 'asc' } }));
    expect(computedFor(asc, REMARKS)!.expr).toEqual({
      op: 'window',
      fn: 'runningSum',
      arg: { col: 'price' },
      by: ['supplier'],
      order: [{ column: 'shipped', dir: 'asc' }],
    });
    expectValid(asc.rules as Rules);
    const desc = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'price', orderBy: { column: 'shipped', dir: 'desc' } }));
    expect(computedFor(desc, REMARKS)!.expr).toMatchObject({ order: [{ column: 'shipped', dir: 'desc' }] });
    expect((computedFor(desc, REMARKS)!.expr as { by?: string[] }).by).toBeUndefined();
  });

  it('is one undo step, and redo gives the same rules back', () => {
    const before = start();
    const after = ok(before, set(REMARKS, { kind: 'runningSum', column: 'qty', groupBy: 'supplier', orderBy: 'file' }));
    const undone = undo(after);
    expect(undone.rules).toBe(before.rules);
    expect(redo(undone).rules).toBe(after.rules);
  });

  it('resolves the "needs your input" entry of the column, like every other method', () => {
    const s = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'qty', orderBy: 'file' }));
    expect(s.rules.unsupported).toEqual([]);
  });

  it('a column typed in from the example input is declared in the same step', () => {
    const out = applyEdit(start(), set(REMARKS, { kind: 'runningSum', column: 'extra', orderBy: 'file' }), { available: [{ header: 'Extra amount', type: 'decimal' }] });
    // the available column's id is the one sourceOptions gave it
    const id = sourceOptions(start().rules, { exampleInput: [{ header: 'Extra amount', type: 'decimal' }] }).find((o) => o.kind === 'available')!.id;
    const second = applyEdit(start(), set(REMARKS, { kind: 'runningSum', column: id, orderBy: 'file' }), { available: [{ header: 'Extra amount', type: 'decimal' }] });
    expect(second.result.ok).toBe(true);
    expect(second.state.rules.input.columns.some((c) => c.id === id)).toBe(true);
    expect(out.result.ok).toBe(false); // "extra" is not the id that column gets
  });
});

describe('Running total: read back', () => {
  const methods: ColumnMethod[] = [
    { kind: 'runningSum', column: 'qty', orderBy: 'file' },
    { kind: 'runningSum', column: 'price', groupBy: 'supplier', orderBy: 'file' },
    { kind: 'runningSum', column: 'price', orderBy: { column: 'shipped', dir: 'desc' } },
    { kind: 'runningSum', column: 'price', groupBy: 'status', orderBy: { column: 'shipped', dir: 'asc' } },
  ];

  it.each(methods.map((m, i) => [i, m] as const))('method %i comes back as the same choice', (_i, m) => {
    const s = ok(start(), set(REMARKS, m));
    expect(readColumnMethod(s.rules, REMARKS)).toEqual(m);
  });

  it('every other across-row function is Advanced: the formula text, not a chip', () => {
    for (const [formula, type] of [
      ['groupSum(qty, by: supplier)', 'integer'],
      ['rank(order: qty desc)', 'integer'],
      ['rowNumber(by: supplier)', 'integer'],
      ['previous(price)', 'decimal'],
      ['fillDown(note)', 'text'],
      ['runningSum(price, by: (supplier, status))', 'decimal'],
      ['runningSum(price, order: (shipped, qty))', 'decimal'],
    ] as const) {
      const s = ok(start(), set(REMARKS, { kind: 'formula', formula, type }));
      expect(readColumnMethod(s.rules, REMARKS), formula).toEqual({ kind: 'formula', formula, type });
    }
  });

  it('a running total with ties:, or written around other things, is a formula too', () => {
    const s = ok(start(), set(REMARKS, { kind: 'formula', formula: 'round(runningSum(price) / 2, 2)', type: 'decimal' }));
    expect(readColumnMethod(s.rules, REMARKS)).toMatchObject({ kind: 'formula', formula: 'round(runningSum(price) / 2, 2)' });
  });
});

describe('Running total: the formula text round trip', () => {
  it('the Advanced view shows runningSum(...) with named arguments, and typing it back gives the same rules', () => {
    const s = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'price', groupBy: 'supplier', orderBy: { column: 'shipped', dir: 'desc' } }));
    const json = advancedJsonOf(s.rules);
    expect(json).toContain('runningSum(price, by: supplier, order: shipped desc)');
    // text that says the same thing gives the very same rules back...
    expect(parseAdvancedJson(json, s.rules)).toBe(s.rules);
    // ...and a change to the formula text is read with the same syntax
    const changed = parseAdvancedJson(json.replace('order: shipped desc', 'order: shipped'), s.rules);
    expect(Array.isArray(changed)).toBe(false);
    expect((changed as Rules).transform.computed.find((c) => c.id === 'running1')!.expr).toEqual({
      op: 'window',
      fn: 'runningSum',
      arg: { col: 'price' },
      by: ['supplier'],
      order: [{ column: 'shipped', dir: 'asc' }],
    });
    // a window written where it cannot run (a row filter) is a formula problem with its path
    const wire = JSON.parse(json) as { input: { rowFilters: unknown[] } };
    wire.input.rowFilters = [{ expr: 'groupSum(qty) > 0' }];
    const bad = parseAdvancedJson(JSON.stringify(wire), s.rules);
    expect(Array.isArray(bad) ? bad[0] : undefined).toMatchObject({ code: 'formula', path: 'input.rowFilters[0].expr' });
  });

  it('a formula written by hand with the new syntax is accepted, checked, and read as the chip when it has exactly that shape', () => {
    const s = ok(start(), set(REMARKS, { kind: 'formula', formula: 'runningSum(price, by: supplier, order: shipped)', type: 'decimal' }));
    expectValid(s.rules as Rules);
    expect(readColumnMethod(s.rules, REMARKS)).toEqual({ kind: 'runningSum', column: 'price', groupBy: 'supplier', orderBy: { column: 'shipped', dir: 'asc' } });
  });

  it('a formula with a mistake in the new syntax says where', () => {
    const p = refused(start(), set(REMARKS, { kind: 'formula', formula: 'runningSum(price, supplier)', type: 'decimal' }));
    expect(p[0]).toMatchObject({ code: 'formula' });
    expect(p[0]!.message).toMatch(/named arguments/);
    expect(p[0]!.offset).toBe(18);
    expect(refused(start(), set(REMARKS, { kind: 'formula', formula: 'groupSum(price, order: shipped)', type: 'decimal' }))[0]!.message).toMatch(/does not take order:/);
  });

  it('across-row functions work only in a computed column: a fan-out value that uses one is refused', () => {
    const p = refused(start(), { type: 'setExpand', expand: { mode: 'fixedFanOut', rows: [{ set: { n: 'rowNumber()' } }] } });
    expect(p[0]).toMatchObject({ code: 'formula' });
    expect(p[0]!.message).toMatch(/works only in a computed column/);
  });

  it('a function named like a built-in across-row function is refused (it could never be called from a formula)', () => {
    const p = refused(start(), { type: 'setFunction', fn: { name: 'rank', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: 'x' } });
    expect(p[0]!.message).toMatch(/formulas already use/);
  });
});

describe('Running total: what is refused', () => {
  it('a column that is not a number: the checker\'s sentence, pointing to a computed column', () => {
    const p = refused(start(), set(REMARKS, { kind: 'runningSum', column: 'supplier', orderBy: 'file' }));
    expect(p[0]).toMatchObject({ code: 'typeMismatch', column: 'supplier' });
    expect(p[0]!.message).toBe('expected decimal, got text; use toNumber in a computed column first');
  });

  it('a column that does not exist, in any of the three places', () => {
    expect(refused(start(), set(REMARKS, { kind: 'runningSum', column: 'zzz', orderBy: 'file' }))[0]).toMatchObject({ code: 'unknownColumn', path: 'column' });
    expect(refused(start(), set(REMARKS, { kind: 'runningSum', column: 'qty', groupBy: 'zzz', orderBy: 'file' }))[0]).toMatchObject({ code: 'unknownColumn', path: 'groupBy' });
    expect(refused(start(), set(REMARKS, { kind: 'runningSum', column: 'qty', orderBy: { column: 'zzz', dir: 'asc' } }))[0]).toMatchObject({ code: 'unknownColumn', path: 'orderBy.column' });
  });
});

describe('Running total: what an edit must not lose', () => {
  it('a helper column that only a group-by or an order-by reads is not pruned when something else changes', () => {
    // A helper (a computed column nobody shows) is the group column of the running total.
    const base = ordersRules();
    const withHelper: Rules = {
      ...base,
      transform: {
        ...base.transform,
        computed: [
          ...base.transform.computed,
          { id: 'bucket', type: 'text', expr: { op: 'substr', arg: { col: 'supplier' }, start: 1, length: 1 } },
          { id: 'running', type: 'decimal', expr: { op: 'window', fn: 'runningSum', arg: { col: 'price' }, by: ['bucket'], order: [{ column: 'shipped', dir: 'asc' }] } },
        ],
      },
      output: { ...base.output, columns: base.output.columns.map((c) => (c.header === 'Remarks' ? { ...c, from: 'running' } : c)) },
      unsupported: [],
    };
    expectValid(withHelper);
    // Re-making the Supplier column (which does not use the helper) leaves the helper alone...
    const edited = ok(start(withHelper), set(1, { kind: 'copy', source: 'supplier' }));
    expect(edited.rules.transform.computed.map((c) => c.id)).toContain('bucket');
    // ...and dropping the running total drops the helper it alone used.
    const dropped = ok(start(withHelper), set(REMARKS, { kind: 'empty' }));
    expect(dropped.rules.transform.computed.map((c) => c.id)).not.toContain('bucket');
    expect(dropped.rules.transform.computed.map((c) => c.id)).not.toContain('running');
  });

  it('what the method reads: the column, the group and the order column', () => {
    expect(methodSources({ kind: 'runningSum', column: 'qty', orderBy: 'file' })).toEqual(['qty']);
    expect(methodSources({ kind: 'runningSum', column: 'qty', groupBy: 'supplier', orderBy: { column: 'shipped', dir: 'asc' } }).sort()).toEqual(['qty', 'shipped', 'supplier']);
    expect(methodSources({ kind: 'formula', formula: 'runningSum(qty, by: supplier, order: shipped)' }).sort()).toEqual(['qty', 'shipped', 'supplier']);
  });

  it('switching back to Copy takes the window column away', () => {
    const s = ok(start(), set(REMARKS, { kind: 'runningSum', column: 'qty', orderBy: 'file' }));
    const back = ok(s, set(REMARKS, { kind: 'copy', source: 'qty' }));
    expect(back.rules.transform.computed.map((c) => c.id)).toEqual(['total']);
  });
});
