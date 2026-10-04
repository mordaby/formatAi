// The rules-editor model (SPEC 8.11): every action gives valid rules or a typed problem, and undo/redo takes it back.
import { checkLimits, formatOf, typeCheck } from '@formatai/engine';
import { checkRules, RulesSchema, type Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { runStaticChecks } from '../worker/liveCheck';
import {
  advancedJsonOf,
  applyEdit,
  canRedo,
  canUndo,
  createEditorState,
  formatFingerprint,
  inputSideChanged,
  lineIdsOf,
  markSaved,
  readColumnMethod,
  redo,
  sourceOptions,
  undo,
  withFormat,
  withSource,
  type ColumnMethod,
  type EditAction,
  type EditorState,
  type EditProblem,
} from './model';
import { legacyTotalsRules, ordersRules } from './testkit';

// ---------- helpers ----------

const start = (rules: Rules = ordersRules(), options = {}): EditorState => createEditorState(rules, options);

function ok(state: EditorState, action: EditAction): EditorState {
  const out = applyEdit(state, action);
  if (!out.result.ok) throw new Error(`${action.type} was refused: ${JSON.stringify(out.result.problems)}`);
  return out.state;
}

function refused(state: EditorState, action: EditAction): EditProblem[] {
  const out = applyEdit(state, action);
  if (out.result.ok) throw new Error(`${action.type} was accepted, expected problems`);
  expect(out.state).toBe(state); // a refused edit leaves the editor exactly as it was
  return out.result.problems;
}

/** The rules pass every layer: zod, references, types and limits. */
function expectValid(rules: Rules): void {
  expect(RulesSchema.safeParse(rules).success).toBe(true);
  expect(checkRules(rules)).toEqual([]);
  expect(runStaticChecks(rules, { tier: 'paid' })).toEqual([]);
}

/** Apply, check the result is valid, undo (back to the very same rules), redo (forward to the very same rules). */
function roundTrip(state: EditorState, action: EditAction): EditorState {
  const after = ok(state, action);
  expect(after.rules).not.toBe(state.rules);
  expectValid(after.rules as Rules);
  const undone = undo(after);
  expect(undone.rules).toBe(state.rules);
  expect(undone.exceptions).toEqual(state.exceptions);
  expect(canRedo(undone)).toBe(true);
  const redone = redo(undone);
  expect(redone.rules).toBe(after.rules);
  return after;
}

const col = (s: EditorState, header: string) => s.rules.output.columns.find((c) => c.header === header)!;
const indexOf = (s: EditorState, header: string): number => s.rules.output.columns.findIndex((c) => c.header === header);
const computedOf = (s: EditorState, header: string) => s.rules.transform.computed.find((c) => c.id === col(s, header).from);
const exprText = (s: EditorState, header: string): string => JSON.stringify(computedOf(s, header)?.expr);

// ---------- the fixture itself ----------

describe('the fixture', () => {
  it('is a valid rules file at every layer (so a failure below is the edit, not the fixture)', () => {
    expectValid(ordersRules());
    expect(RulesSchema.safeParse(legacyTotalsRules()).success).toBe(true);
    expect(checkRules(legacyTotalsRules())).toEqual([]);
  });
});

// ---------- creating ----------

describe('createEditorState', () => {
  it('starts clean, with nothing edited', () => {
    const s = start();
    expect(s.dirty).toBe(false);
    expect(s.formatChange).toBe(false);
    expect(s.edited.size).toBe(0);
    expect(s.exceptions).toEqual([]);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
    expect(s.format).toBeNull();
  });

  it('knows a conversion belongs to a format from its meta, or from what the caller says', () => {
    const r = ordersRules();
    expect(start({ ...r, meta: { ...r.meta, formatId: 'f1' } }).format).toEqual({ sourceCount: 1 });
    expect(start(r, { format: { sourceCount: 4 } }).format).toEqual({ sourceCount: 4 });
    expect(start({ ...r, meta: { ...r.meta, formatId: 'f1' } }, { format: null }).format).toBeNull();
  });

  it('lists the lines of the rules map with the map ids', () => {
    expect(lineIdsOf(ordersRules())).toEqual([
      'col:Item',
      'col:Supplier',
      'col:Qty',
      'col:Total',
      'col:Shipped',
      'col:Remarks',
      'filter:0',
      'filter:1',
      'sort',
      'summary:end:0',
      'title:0',
      'title:1',
      'check:0',
      'check:1',
    ]);
  });
});

// ---------- columns ----------

describe('setColumnHeader', () => {
  it('renames the column and everything that names it: summary rows, output checks, "needs input"/"please check"', () => {
    const s = roundTrip(start(), { type: 'setColumnHeader', index: indexOf(start(), 'Total'), header: 'Amount' });
    expect(s.rules.output.columns[3]!.header).toBe('Amount');
    expect(s.rules.output.summaryRows![0]!.cells).toEqual({ Qty: 'sum', Amount: 'sum' });
    expect(s.rules.validations[1]).toMatchObject({ on: 'output', column: 'Amount' });
    expect(s.rules.assumptions).toEqual([{ outputColumn: 'Amount', reasonCode: 'roundingGuessed' }]);
    expect(s.edited.has('col:Amount')).toBe(true);
    expect(s.edited.has('col:Total')).toBe(false);
  });

  it('renames the label column of a summary row too', () => {
    const s = ok(start(), { type: 'setColumnHeader', index: 0, header: 'SKU' });
    expect(s.rules.output.summaryRows![0]!.labelColumn).toBe('SKU');
    expectValid(s.rules as Rules);
  });

  it('refuses an empty or duplicate name', () => {
    const s = start();
    expect(refused(s, { type: 'setColumnHeader', index: 0, header: '   ' })[0]!.code).toBe('emptyHeader');
    const dup = refused(s, { type: 'setColumnHeader', index: 0, header: 'Qty' });
    expect(dup[0]!.code).toBe('duplicateHeader');
    expect(refused(s, { type: 'setColumnHeader', index: 99, header: 'x' })[0]!.code).toBe('noSuchItem');
  });

  it('renaming a column to the name it has is nothing', () => {
    const s = start();
    const out = applyEdit(s, { type: 'setColumnHeader', index: 0, header: 'Item' });
    expect(out.result).toEqual({ ok: true, changed: false });
    expect(out.state).toBe(s);
  });
});

describe('reorderColumns / addColumn / removeColumn', () => {
  it('moves a column', () => {
    const s = roundTrip(start(), { type: 'reorderColumns', from: 3, to: 0 });
    expect(s.rules.output.columns.map((c) => c.header)).toEqual(['Total', 'Item', 'Supplier', 'Qty', 'Shipped', 'Remarks']);
    expect(s.edited.has('col:Total')).toBe(true);
  });

  it('adds a column: empty by default, with a generated name, at a position', () => {
    const s = roundTrip(start(), { type: 'addColumn', at: 1 });
    expect(s.rules.output.columns[1]).toEqual({ header: 'Column 7', from: null });
    expect(s.edited.has('col:Column 7')).toBe(true);
  });

  it('adds a column with a method', () => {
    const s = roundTrip(start(), { type: 'addColumn', header: 'Twice', method: { kind: 'calculate', terms: [{ column: 'qty' }, { number: 2 }], ops: ['*'] } });
    expect(readColumnMethod(s.rules, 6)).toEqual({ kind: 'calculate', terms: [{ column: 'qty' }, { number: 2 }], ops: ['*'] });
  });

  it('refuses a duplicate header on add', () => {
    expect(refused(start(), { type: 'addColumn', header: 'Qty' })[0]!.code).toBe('duplicateHeader');
  });

  it('removes a column and what only it used: its helper column, summary cells, output checks, "please check"', () => {
    const s = roundTrip(start(), { type: 'removeColumn', index: 3 });
    expect(s.rules.output.columns.map((c) => c.header)).not.toContain('Total');
    expect(s.rules.transform.computed).toEqual([]); // `total` fed only that column
    expect(s.rules.output.summaryRows![0]!.cells).toEqual({ Qty: 'sum' });
    expect(s.rules.validations).toHaveLength(1);
    expect(s.rules.assumptions).toEqual([]);
  });

  it('removing a column also removes the value map only it read', () => {
    const s = roundTrip(start(), { type: 'removeColumn', index: 1 });
    expect(s.rules.transform.valueMaps).toEqual([]);
  });

  it('removing the label column drops the label reference, not the row', () => {
    const s = ok(start(), { type: 'removeColumn', index: 0 });
    expect(s.rules.output.summaryRows![0]).toEqual({ label: 'Total', bold: true, cells: { Qty: 'sum', Total: 'sum' } });
    expectValid(s.rules as Rules);
  });

  it('keeps a helper column another column still uses', () => {
    let s = ok(start(), { type: 'addColumn', header: 'Total copy', method: { kind: 'copy', source: 'total' } });
    expect(col(s, 'Total copy').from).toBe('total');
    s = ok(s, { type: 'removeColumn', index: indexOf(s, 'Total') });
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total']);
  });

  it('a file needs at least one column', () => {
    let s = start();
    while (s.rules.output.columns.length > 1) s = ok(s, { type: 'removeColumn', index: 0 });
    expect(refused(s, { type: 'removeColumn', index: 0 })[0]!.code).toBe('rule');
  });
});

describe('setColumnFormat / setColumnAgg', () => {
  it('sets, changes and clears the output format and width', () => {
    let s = roundTrip(start(), { type: 'setColumnFormat', index: 2, format: '#,##0', width: 9 });
    expect(col(s, 'Qty')).toEqual({ header: 'Qty', from: 'qty', format: '#,##0', width: 9 });
    s = ok(s, { type: 'setColumnFormat', index: 2, format: null, width: null });
    expect(col(s, 'Qty')).toEqual({ header: 'Qty', from: 'qty' });
  });

  it('refuses an empty format and a bad width', () => {
    expect(refused(start(), { type: 'setColumnFormat', index: 2, format: ' ' })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'setColumnFormat', index: 2, width: -1 })[0]!.code).toBe('badValue');
  });

  it('sets a summary aggregate on a column', () => {
    const s = roundTrip(start(), { type: 'setColumnAgg', index: 2, agg: 'sum' });
    expect(col(s, 'Qty').agg).toBe('sum');
    expect(col(ok(s, { type: 'setColumnAgg', index: 2, agg: null }), 'Qty').agg).toBeUndefined();
  });
});

// ---------- column methods ----------

describe('setColumnMethod: copy', () => {
  it('copies a column straight through', () => {
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 2, method: { kind: 'copy', source: 'price' } });
    expect(col(s, 'Qty').from).toBe('price');
    expect(readColumnMethod(s.rules, 2)).toEqual({ kind: 'copy', source: 'price' });
  });

  it('pads and trims through a helper column that belongs to this output column', () => {
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'copy', source: 'supplier', trim: true, padLeft: 8 } });
    const c = computedOf(s, 'Supplier')!;
    expect(c.id).toBe('copy1');
    expect(c.type).toBe('text');
    expect(c.expr).toEqual({ op: 'padLeft', length: 8, char: '0', arg: { op: 'trim', arg: { col: 'supplier' } } });
    expect(readColumnMethod(s.rules, 1)).toEqual({ kind: 'copy', source: 'supplier', trim: true, padLeft: 8 });
    // the value map on `supplier` is no longer read by this column and nothing else reads it
    expect(s.rules.transform.valueMaps).toEqual([]);
  });

  it('a number is turned to text first when it is padded', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: 'qty', padLeft: 5 } });
    expect(computedOf(s, 'Remarks')!.expr).toEqual({ op: 'padLeft', length: 5, char: '0', arg: { op: 'toText', arg: { col: 'qty' } } });
    expectValid(s.rules as Rules);
    expect(readColumnMethod(s.rules, 5)).toEqual({ kind: 'copy', source: 'qty', padLeft: 5 });
  });

  it('padding an input column to the length it already has is a plain copy', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: 0, method: { kind: 'copy', source: 'sku', padLeft: 6 } });
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total']);
    expect(col(s, 'Item').from).toBe('sku');
  });

  it('reading an input column that pads at read time says so', () => {
    expect(readColumnMethod(ordersRules(), 0)).toEqual({ kind: 'copy', source: 'sku', padLeft: 6 });
  });

  it('refuses an unknown column and a bad padding', () => {
    const p = refused(start(), { type: 'setColumnMethod', index: 0, method: { kind: 'copy', source: 'nope' } });
    expect(p[0]).toMatchObject({ code: 'unknownColumn', column: 'nope' });
    expect(refused(start(), { type: 'setColumnMethod', index: 0, method: { kind: 'copy', source: 'sku', padLeft: 0 } })[0]!.code).toBe('badValue');
  });

  it('resolves "needs your input" and "please check" for the column', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: indexOf(start(), 'Remarks'), method: { kind: 'copy', source: 'note' } });
    expect(s.rules.unsupported).toEqual([]);
    const t = ok(start(), { type: 'setColumnMethod', index: indexOf(start(), 'Total'), method: { kind: 'copy', source: 'price' } });
    expect(t.rules.assumptions).toEqual([]);
  });
});

describe('setColumnMethod: what a shared value map and a shared helper mean', () => {
  it('copying a column that a value map translates gives the raw value (a helper column reads it before the maps run)', () => {
    // Column "Supplier" is a learned translate: a value map right on `supplier`. Copy it instead.
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'copy', source: 'supplier' } });
    expect(computedOf(s, 'Supplier')).toMatchObject({ id: 'copy1', expr: { col: 'supplier' }, type: 'text' });
    expect(readColumnMethod(s.rules, 1)).toEqual({ kind: 'copy', source: 'supplier' });
    expect(s.rules.transform.valueMaps).toEqual([]); // nothing reads the translated value any more
  });

  it('a new column copying a translated column does not steal its translation, and the translated one keeps it', () => {
    const s = roundTrip(start(), { type: 'addColumn', header: 'Raw supplier', method: { kind: 'copy', source: 'supplier' } });
    expect(readColumnMethod(s.rules, 1)).toMatchObject({ kind: 'translate', source: 'supplier' });
    expect(readColumnMethod(s.rules, 6)).toEqual({ kind: 'copy', source: 'supplier' });
    expect(s.rules.transform.valueMaps).toHaveLength(1);
  });

  it('translating a column that shares its source with another one does not translate the other', () => {
    let s = ok(start(), { type: 'addColumn', header: 'Status A', method: { kind: 'copy', source: 'status' } });
    s = ok(s, { type: 'addColumn', header: 'Status B', method: { kind: 'copy', source: 'status' } });
    s = roundTrip(s, { type: 'setColumnMethod', index: indexOf(s, 'Status A'), method: { kind: 'translate', source: 'status', pairs: [{ from: 'open', to: 'O' }], onMissing: 'keep' } });
    expect(s.rules.transform.valueMaps.some((v) => v.column === 'status')).toBe(false); // no map on the shared input id
    expect(readColumnMethod(s.rules, indexOf(s, 'Status B'))).toEqual({ kind: 'copy', source: 'status' });
  });

  it('editing a helper column again frees what it read before', () => {
    let s = ok(start(), { type: 'addColumn', header: 'Net', method: { kind: 'formula', formula: 'total * 0.83', type: 'decimal' } });
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total', 'expr1']);
    s = ok(s, { type: 'removeColumn', index: indexOf(s, 'Total') }); // 'total' is still read by the Net helper
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total', 'expr1']);
    s = ok(s, { type: 'setColumnMethod', index: indexOf(s, 'Net'), method: { kind: 'copy', source: 'price' } });
    expect(s.rules.transform.computed).toEqual([]); // 'total' was only kept alive by Net's old formula
    expectValid(s.rules as Rules);
  });
});

describe('setColumnMethod: calculate', () => {
  const calc = (terms: Extract<ColumnMethod, { kind: 'calculate' }>['terms'], ops: Extract<ColumnMethod, { kind: 'calculate' }>['ops'], round?: number): ColumnMethod =>
    ({ kind: 'calculate', terms, ops, ...(round === undefined ? {} : { round }) });

  it('builds a formula tree from blocks: two terms, rounded', () => {
    const m = calc([{ column: 'price' }, { number: 0.17 }], ['*'], 2);
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 2, method: m });
    const c = computedOf(s, 'Qty')!;
    expect(c.type).toBe('decimal');
    expect(c.expr).toEqual({ op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'price' }, { const: 0.17 }] } });
    expect(readColumnMethod(s.rules, 2)).toEqual(m);
  });

  it('follows the usual precedence: x and / before + and -', () => {
    const mixed = ok(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['+', '*']) });
    expect(computedOf(mixed, 'Qty')!.expr).toEqual({ op: 'add', args: [{ col: 'qty' }, { op: 'mul', args: [{ col: 'price' }, { const: 3 }] }] });
    const left = ok(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['*', '+']) });
    expect(computedOf(left, 'Qty')!.expr).toEqual({ op: 'add', args: [{ op: 'mul', args: [{ col: 'qty' }, { col: 'price' }] }, { const: 3 }] });
    const chain = ok(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['-', '-']) });
    expect(computedOf(chain, 'Qty')!.expr).toEqual({ op: 'sub', args: [{ col: 'qty' }, { col: 'price' }, { const: 3 }] });
    for (const s of [mixed, left, chain]) expectValid(s.rules as Rules);
  });

  it('reads back what it built, for every shape', () => {
    const shapes: ColumnMethod[] = [
      calc([{ column: 'qty' }, { column: 'price' }], ['+']),
      calc([{ column: 'qty' }, { column: 'price' }], ['-'], 0),
      calc([{ column: 'qty' }, { column: 'price' }], ['/'], 4),
      calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['+', '*']),
      calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['*', '+']),
      calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['*', '/']),
      calc([{ column: 'qty' }, { column: 'price' }, { number: 3 }], ['-', '-'], 2),
      calc([{ column: 'price' }], [], 2),
    ];
    for (const m of shapes) {
      const s = ok(start(), { type: 'setColumnMethod', index: 2, method: m });
      expectValid(s.rules as Rules);
      expect(readColumnMethod(s.rules, 2)).toEqual(m);
    }
  });

  it('calculating on a text column is refused with the type checker\'s own words', () => {
    const p = refused(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'supplier' }, { number: 2 }], ['*']) });
    expect(p[0]).toMatchObject({ code: 'typeMismatch', column: 'supplier', path: 'terms[0]' });
    // ...the same sentence `typeCheck` gives for the same rules file
    const forced: Rules = {
      ...ordersRules(),
      transform: { ...ordersRules().transform, computed: [{ id: 'bad', type: 'decimal', expr: { op: 'mul', args: [{ col: 'supplier' }, { const: 2 }] } }] },
    };
    expect(typeCheck(forced).map((t) => t.message)).toContain(p[0]!.message);
    expect(p[0]!.message).toBe('expected decimal, got text; use toNumber');
  });

  it('a text column can be read as a number on request', () => {
    const m = calc([{ column: 'note', toNumber: true }, { number: 1 }], ['+']);
    const s = ok(start(), { type: 'setColumnMethod', index: 2, method: m });
    expect(computedOf(s, 'Qty')!.expr).toEqual({ op: 'add', args: [{ op: 'toNumber', arg: { col: 'note' } }, { const: 1 }] });
    expectValid(s.rules as Rules);
    expect(readColumnMethod(s.rules, 2)).toEqual(m);
    // but a date is not a number, toNumber or not
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'shipped', toNumber: true }, { number: 1 }], ['+']) })[0]!.message).toBe('expected decimal, got date');
  });

  it('allows up to 3 terms, and needs one operator between terms', () => {
    const four = calc([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }], ['+', '+', '+']);
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: four })[0]!.code).toBe('tooManyTerms');
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { number: 1 }], []) })[0]!.code).toBe('badOperators');
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: calc([], []) })[0]!.code).toBe('tooFewTerms');
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { number: Number.NaN }], ['+']) })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }], [], 2.5) })[0]!.code).toBe('badValue');
  });

  it('editing a calculation again reuses its helper column (same id)', () => {
    let s = ok(start(), { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { number: 2 }], ['*']) });
    const id = col(s, 'Qty').from;
    s = ok(s, { type: 'setColumnMethod', index: 2, method: calc([{ column: 'qty' }, { number: 3 }], ['*']) });
    expect(col(s, 'Qty').from).toBe(id);
    expect(s.rules.transform.computed.filter((c) => c.id === id)).toHaveLength(1);
  });

  it('changing a learned calculation to a copy drops the helper it made', () => {
    const s = roundTrip(start(), { type: 'setColumnMethod', index: indexOf(start(), 'Total'), method: { kind: 'copy', source: 'price' } });
    expect(s.rules.transform.computed).toEqual([]);
  });

  it('a learned calculation reads back as blocks; a learned rounding of a product too', () => {
    expect(readColumnMethod(ordersRules(), 3)).toEqual({ kind: 'calculate', terms: [{ column: 'qty' }, { column: 'price' }], ops: ['*'], round: 2 });
  });
});

describe('setColumnMethod: join, part of text, fixed, empty, translate', () => {
  it('joins columns with a separator; numbers and dates go through toText', () => {
    const m: ColumnMethod = { kind: 'join', columns: ['sku', 'supplier', 'qty'], separator: ' - ' };
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: m });
    expect(computedOf(s, 'Supplier')!.type).toBe('text');
    expect(computedOf(s, 'Supplier')!.expr).toEqual({
      op: 'concat',
      args: [{ col: 'sku' }, { const: ' - ' }, { col: 'supplier' }, { const: ' - ' }, { op: 'toText', arg: { col: 'qty' } }],
    });
    expect(readColumnMethod(s.rules, 1)).toEqual(m);
  });

  it('joins with no separator, and needs two columns', () => {
    const m: ColumnMethod = { kind: 'join', columns: ['sku', 'supplier'], separator: '' };
    const s = ok(start(), { type: 'setColumnMethod', index: 1, method: m });
    expect(computedOf(s, 'Supplier')!.expr).toEqual({ op: 'concat', args: [{ col: 'sku' }, { col: 'supplier' }] });
    expect(readColumnMethod(s.rules, 1)).toEqual(m);
    expect(refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'join', columns: ['sku'], separator: '-' } })[0]!.code).toBe('tooFewTerms');
    expect(refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'join', columns: ['sku', 'zzz'], separator: '-' } })[0]!.code).toBe('unknownColumn');
  });

  it('takes the first or last N characters', () => {
    const first = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'partOfText', source: 'supplier', part: 'first', n: 3 } });
    expect(computedOf(first, 'Supplier')!.expr).toEqual({ op: 'substr', arg: { col: 'supplier' }, start: 1, length: 3 });
    const last = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'partOfText', source: 'supplier', part: 'last', n: 2 } });
    expect(computedOf(last, 'Supplier')!.expr).toEqual({ op: 'substr', arg: { col: 'supplier' }, start: -2, length: 2 });
    expect(readColumnMethod(first.rules, 1)).toEqual({ kind: 'partOfText', source: 'supplier', part: 'first', n: 3 });
    expect(readColumnMethod(last.rules, 1)).toEqual({ kind: 'partOfText', source: 'supplier', part: 'last', n: 2 });
    expect(refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'partOfText', source: 'supplier', part: 'first', n: 0 } })[0]!.code).toBe('badValue');
  });

  it('part of text on a number turns it to text first', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'partOfText', source: 'qty', part: 'last', n: 1 } });
    expect(computedOf(s, 'Supplier')!.expr).toEqual({ op: 'substr', arg: { op: 'toText', arg: { col: 'qty' } }, start: -1, length: 1 });
    expectValid(s.rules as Rules);
    expect(readColumnMethod(s.rules, 1)).toEqual({ kind: 'partOfText', source: 'qty', part: 'last', n: 1 });
  });

  it('a fixed value: text, whole number, decimal, yes/no', () => {
    const cases: [string | number | boolean, string][] = [
      ['n/a', 'text'],
      [7, 'integer'],
      [0.5, 'decimal'],
      [true, 'boolean'],
    ];
    for (const [value, type] of cases) {
      const s = roundTrip(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'fixed', value } });
      expect(computedOf(s, 'Supplier')).toMatchObject({ type, expr: { const: value } });
      expect(readColumnMethod(s.rules, 1)).toEqual({ kind: 'fixed', value });
    }
    expect(refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'fixed', value: Number.POSITIVE_INFINITY } })[0]!.code).toBe('badValue');
  });

  it('leave empty: no source, its helper column gone, "needs your input" resolved', () => {
    const s = roundTrip(start(), { type: 'setColumnMethod', index: indexOf(start(), 'Total'), method: { kind: 'empty' } });
    expect(col(s, 'Total').from).toBeNull();
    expect(s.rules.transform.computed).toEqual([]);
    expect(s.rules.assumptions).toEqual([]);
    expect(readColumnMethod(s.rules, indexOf(s, 'Total'))).toEqual({ kind: 'empty' });
    // ...and on a "needs your input" column it resolves the reason
    const t = ok(start(), { type: 'setColumnMethod', index: indexOf(start(), 'Remarks'), method: { kind: 'empty' } });
    expect(t.rules.unsupported).toEqual([]);
  });

  it('translate values: a helper copy of the source plus a value map, so no other column changes', () => {
    const m: ColumnMethod = { kind: 'translate', source: 'status', pairs: [{ from: 'open', to: 'O' }, { from: 'closed', to: 'C' }], onMissing: 'flag' };
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 5, method: m });
    const c = computedOf(s, 'Remarks')!;
    expect(c).toMatchObject({ id: 'tr1', type: 'text', expr: { col: 'status' } });
    expect(s.rules.transform.valueMaps).toContainEqual({ column: 'tr1', map: { open: 'O', closed: 'C' }, onMissing: 'flag' });
    expect(readColumnMethod(s.rules, 5)).toEqual(m);
  });

  it('a learned value map right on the source reads as translate, and editing it edits it in place', () => {
    const before = start();
    const learned = readColumnMethod(before.rules, 1) as Extract<ColumnMethod, { kind: 'translate' }>;
    expect(learned).toEqual({ kind: 'translate', source: 'supplier', pairs: [{ from: 'Acme', to: 'ACM' }, { from: 'Borealis', to: 'BOR' }], onMissing: 'keep' });
    const s = roundTrip(before, { type: 'setColumnMethod', index: 1, method: { ...learned, pairs: [...learned.pairs, { from: 'Cobalt', to: 'COB' }], onMissing: 'flag' } });
    expect(col(s, 'Supplier').from).toBe('supplier');
    expect(s.rules.transform.valueMaps).toEqual([{ column: 'supplier', map: { Acme: 'ACM', Borealis: 'BOR', Cobalt: 'COB' }, onMissing: 'flag' }]);
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total']);
  });

  it('translate: a number source keeps its type in the helper; keys are unique and not empty', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'translate', source: 'qty', pairs: [{ from: '1', to: 'one' }], onMissing: 'keep' } });
    expect(computedOf(s, 'Supplier')!.type).toBe('integer');
    expectValid(s.rules as Rules);
    const dup = refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'translate', source: 'status', pairs: [{ from: 'a', to: '1' }, { from: 'a', to: '2' }], onMissing: 'keep' } });
    expect(dup[0]!.code).toBe('duplicateKey');
    const empty = refused(start(), { type: 'setColumnMethod', index: 1, method: { kind: 'translate', source: 'status', pairs: [{ from: '', to: '2' }], onMissing: 'keep' } });
    expect(empty[0]!.code).toBe('badValue');
  });

  it('translate keeps odd keys such as __proto__ as data', () => {
    const s = ok(start(), { type: 'setColumnMethod', index: 5, method: { kind: 'translate', source: 'status', pairs: [{ from: '__proto__', to: 'x' }], onMissing: 'keep' } });
    expect(Object.keys(s.rules.transform.valueMaps.find((v) => v.column === 'tr1')!.map)).toEqual(['__proto__']);
    expect(readColumnMethod(s.rules, 5)).toMatchObject({ kind: 'translate', pairs: [{ from: '__proto__', to: 'x' }] });
  });

  it('a second helper column gets the next generated id', () => {
    let s = ok(start(), { type: 'setColumnMethod', index: 5, method: { kind: 'fixed', value: 1 } });
    s = ok(s, { type: 'setColumnMethod', index: 1, method: { kind: 'fixed', value: 2 } });
    expect(s.rules.transform.computed.map((c) => c.id)).toEqual(['total', 'fixed1', 'fixed2']);
  });
});

describe('setColumnMethod: formula (Advanced)', () => {
  it('parses formula text into the whitelisted tree', () => {
    const s = roundTrip(start(), { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'if(qty > 10, price * 0.9, price)', type: 'decimal' } });
    expect(computedOf(s, 'Qty')!.expr).toMatchObject({ op: 'if' });
    expect(readColumnMethod(s.rules, 2)).toEqual({ kind: 'formula', formula: 'if(qty > 10, price * 0.9, price)', type: 'decimal' });
  });

  it('says where a formula is wrong', () => {
    const p = refused(start(), { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'round(qty *, 2)' } });
    expect(p[0]).toMatchObject({ code: 'formula', path: 'formula' });
    expect(typeof p[0]!.offset).toBe('number');
    expect(refused(start(), { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'nope(qty)' } })[0]!.code).toBe('reference'); // parsed as a call to a function that does not exist
  });

  it('a formula naming a column that does not exist is a reference problem', () => {
    const p = refused(start(), { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'ghost * 2', type: 'decimal' } });
    expect(p[0]!.code).toBe('reference');
    expect(p[0]!.message).toContain('ghost');
  });

  it('anything the blocks cannot say reads back as a formula', () => {
    const r = ordersRules();
    const s = start({ ...r, transform: { ...r.transform, computed: [{ id: 'total', type: 'decimal', expr: { op: 'if', cond: { op: 'gt', args: [{ col: 'qty' }, { const: 1 }] }, then: { col: 'price' }, else: { const: 0 } } }] } });
    expect(readColumnMethod(s.rules, 3)).toEqual({ kind: 'formula', formula: 'if(qty > 1, price, 0)', type: 'decimal' });
  });
});

describe('source options', () => {
  it('offers input columns, and computed columns an output column shows (by that column\'s header)', () => {
    const opts = sourceOptions(ordersRules(), { forColumn: 2 });
    expect(opts.map((o) => [o.id, o.label, o.kind])).toEqual([
      ['sku', 'Item', 'input'],
      ['supplier', 'Supplier', 'input'],
      ['qty', 'Qty', 'input'],
      ['price', 'Unit price', 'input'],
      ['status', 'Status', 'input'],
      ['shipped', 'Shipped', 'input'],
      ['note', 'Note', 'input'],
      ['total', 'Total', 'computed'],
    ]);
    expect(opts.find((o) => o.id === 'qty')!.type).toBe('integer');
  });

  it('never offers the column\'s own helper column as its own source', () => {
    const ids = sourceOptions(ordersRules(), { forColumn: 3 }).map((o) => o.id);
    expect(ids).not.toContain('total');
  });
});

// ---------- rows ----------

describe('filters', () => {
  it('adds a filter as a sentence: column, op, value; a text for a number column is read as a number', () => {
    const s = roundTrip(start(), { type: 'addFilter', filter: { column: 'price', op: 'gte', value: '2,50' as unknown as string } });
    // "2,50" is not a number in this reading (comma is a thousands separator: 250)
    expect(s.rules.input.rowFilters![2]).toEqual({ column: 'price', op: 'gte', value: 250 });
    const t = ok(start(), { type: 'addFilter', filter: { column: 'price', op: 'lt', value: '99.5' } });
    expect(t.rules.input.rowFilters![2]).toEqual({ column: 'price', op: 'lt', value: 99.5 });
    expect(t.edited.has('filter:2')).toBe(true);
  });

  it('is empty / is not empty need no value; is one of needs a list', () => {
    const a = roundTrip(start(), { type: 'addFilter', filter: { column: 'note', op: 'notEmpty' } });
    expect(a.rules.input.rowFilters![2]).toEqual({ column: 'note', op: 'notEmpty' });
    const b = roundTrip(start(), { type: 'addFilter', filter: { column: 'status', op: 'oneOf', value: ['open', 'closed'] } });
    expect(b.rules.input.rowFilters![2]).toEqual({ column: 'status', op: 'oneOf', value: ['open', 'closed'] });
    const c = ok(start(), { type: 'addFilter', filter: { column: 'status', op: 'notOneOf', value: 'x' as unknown as string } });
    expect(c.rules.input.rowFilters![2]).toEqual({ column: 'status', op: 'notOneOf', value: ['x'] });
    expect(refused(start(), { type: 'addFilter', filter: { column: 'status', op: 'oneOf', value: [] } })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'addFilter', filter: { column: 'status', op: 'eq' } })[0]!.code).toBe('badValue');
  });

  it('keeps a text id as text (leading zeros matter)', () => {
    const s = ok(start(), { type: 'addFilter', filter: { column: 'sku', op: 'eq', value: '000123' } });
    expect(s.rules.input.rowFilters![2]).toEqual({ column: 'sku', op: 'eq', value: '000123' });
  });

  it('refuses a value that does not suit the column, in the type checker\'s words', () => {
    const p = refused(start(), { type: 'addFilter', filter: { column: 'qty', op: 'gt', value: 'lots' } });
    expect(p[0]).toMatchObject({ code: 'typeMismatch', column: 'qty', message: 'filter value does not suit column "qty" (integer): got text' });
    const forced: Rules = { ...ordersRules(), input: { ...ordersRules().input, rowFilters: [{ column: 'qty', op: 'gt', value: 'lots' }] } };
    expect(typeCheck(forced).map((t) => t.message)).toContain(p[0]!.message);
    expect(refused(start(), { type: 'addFilter', filter: { column: 'shipped', op: 'gt', value: '2024-01-01' } })[0]!.code).toBe('typeMismatch');
    expect(refused(start(), { type: 'addFilter', filter: { column: 'ghost', op: 'eq', value: 'x' } })[0]!.code).toBe('unknownColumn');
  });

  it('updates and removes a filter; removing one does not make the others look edited', () => {
    const u = roundTrip(start(), { type: 'updateFilter', index: 0, filter: { column: 'status', op: 'eq', value: 'shipped' } });
    expect(u.rules.input.rowFilters![0]).toEqual({ column: 'status', op: 'eq', value: 'shipped' });
    expect([...u.edited]).toEqual(['filter:0']);
    const r = roundTrip(start(), { type: 'removeFilter', index: 0 });
    expect(r.rules.input.rowFilters).toEqual([{ column: 'qty', op: 'gt', value: 0 }]);
    expect([...r.edited]).toEqual([]); // the old filter 1 is now filter 0 and unchanged
    const none = ok(r, { type: 'removeFilter', index: 0 });
    expect(none.rules.input.rowFilters).toBeUndefined();
    expect(refused(start(), { type: 'removeFilter', index: 5 })[0]!.code).toBe('noSuchItem');
    expect(refused(start(), { type: 'updateFilter', index: 5, filter: { column: 'qty', op: 'isEmpty' } })[0]!.code).toBe('noSuchItem');
  });
});

describe('duplicates', () => {
  it('turns on (flagging, all columns, keep first) and off', () => {
    const on = roundTrip(start(), { type: 'setDedupe', enabled: true });
    expect(on.rules.transform.dedupe).toEqual({ keys: 'all', keep: 'first', action: 'flag' });
    expect(on.edited.has('dedupe')).toBe(true);
    const off = ok(on, { type: 'setDedupe', enabled: false });
    expect(off.rules.transform.dedupe).toBeUndefined();
    expect(applyEdit(off, { type: 'setDedupe', enabled: false }).result).toEqual({ ok: true, changed: false });
  });

  it('chooses the columns, first or last, remove or flag; a change keeps what it does not name', () => {
    let s = ok(start(), { type: 'setDedupe', enabled: true, keys: ['sku', 'supplier'], keep: 'last', action: 'remove' });
    expect(s.rules.transform.dedupe).toEqual({ keys: ['sku', 'supplier'], keep: 'last', action: 'remove' });
    s = ok(s, { type: 'setDedupe', enabled: true, action: 'flag' });
    expect(s.rules.transform.dedupe).toEqual({ keys: ['sku', 'supplier'], keep: 'last', action: 'flag' });
    expectValid(s.rules as Rules);
  });

  it('needs real columns, and at least one', () => {
    expect(refused(start(), { type: 'setDedupe', enabled: true, keys: ['ghost'] })[0]).toMatchObject({ code: 'unknownColumn', column: 'ghost' });
    expect(refused(start(), { type: 'setDedupe', enabled: true, keys: [] })[0]!.code).toBe('badValue');
  });
});

describe('expand', () => {
  it('columns to rows, split cell and fixed fan-out', () => {
    const base = ordersRules();
    // Drop the columns the expand removes so the file stays consistent.
    const r: Rules = {
      ...base,
      input: { ...base.input, rowFilters: [] },
      transform: { ...base.transform, computed: [], valueMaps: [], sort: [] },
      output: { ...base.output, columns: [{ header: 'Item', from: 'sku' }, { header: 'Month', from: 'month' }, { header: 'Amount', from: 'amount' }], summaryRows: [] },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const s0 = start(r);
    const c2r = roundTrip(s0, {
      type: 'setExpand',
      expand: { mode: 'columnsToRows', columns: ['qty', 'price'], labelId: 'month', valueId: 'amount', valueType: 'decimal', skipEmpty: true },
    });
    expect(c2r.rules.transform.expand).toMatchObject({ mode: 'columnsToRows', labelId: 'month' });
    expect(c2r.edited.has('expand')).toBe(true);

    const split = roundTrip(
      start({ ...r, output: { ...r.output, columns: [{ header: 'Item', from: 'sku' }, { header: 'Part', from: 'part' }] } }),
      { type: 'setExpand', expand: { mode: 'splitCell', column: 'note', separator: ';', trim: true, partId: 'part', indexId: 'pos', skipEmpty: true } },
    );
    expect(split.rules.transform.expand).toMatchObject({ mode: 'splitCell', partId: 'part', indexId: 'pos' });

    const fan = roundTrip(
      start({ ...r, output: { ...r.output, columns: [{ header: 'Item', from: 'sku' }, { header: 'Side', from: 'side' }] } }),
      { type: 'setExpand', expand: { mode: 'fixedFanOut', rows: [{ set: { side: '"debit"' } }, { set: { side: '"credit"' } }] } },
    );
    expect(fan.rules.transform.expand).toEqual({ mode: 'fixedFanOut', rows: [{ set: { side: { const: 'debit' } } }, { set: { side: { const: 'credit' } } }] });

    // taking the fan-out away would strand the column that reads what it made
    expect(refused(fan, { type: 'setExpand', expand: null })[0]!.code).toBe('reference');
  });

  it('refuses ids that collide, unknown columns, and formulas that do not parse', () => {
    const s = start();
    expect(refused(s, { type: 'setExpand', expand: { mode: 'splitCell', column: 'note', separator: ';', trim: true, partId: 'qty', skipEmpty: true } })[0]!.code).toBe('reference');
    expect(refused(s, { type: 'setExpand', expand: { mode: 'splitCell', column: 'ghost', separator: ';', trim: true, partId: 'part', skipEmpty: true } })[0]!.code).toBe('unknownColumn');
    expect(refused(s, { type: 'setExpand', expand: { mode: 'splitCell', column: 'note', separator: '', trim: true, partId: 'part', skipEmpty: true } })[0]!.code).toBe('badValue');
    expect(refused(s, { type: 'setExpand', expand: { mode: 'splitCell', column: 'note', separator: ';', trim: true, partId: 'not valid', skipEmpty: true } })[0]!.code).toBe('badValue');
    const f = refused(s, { type: 'setExpand', expand: { mode: 'fixedFanOut', rows: [{ set: { side: '"a" +' } }] } });
    expect(f[0]).toMatchObject({ code: 'formula', path: 'rows[0].set.side' });
    expect(refused(s, { type: 'setExpand', expand: { mode: 'columnsToRows', columns: [], labelId: 'l', valueId: 'v', valueType: 'text', skipEmpty: false } })[0]!.code).toBe('tooFewTerms');
  });

  it('an expand that removes a column something still reads is refused with the reference problem', () => {
    const p = refused(start(), { type: 'setExpand', expand: { mode: 'columnsToRows', columns: ['qty'], labelId: 'lab', valueId: 'val', valueType: 'decimal', skipEmpty: true } });
    expect(p.every((x) => x.code === 'reference')).toBe(true);
    expect(p.some((x) => x.message.includes('"qty"'))).toBe(true);
  });
});

// ---------- layout ----------

describe('title', () => {
  it('sets, adds, removes and replaces title rows', () => {
    const t = roundTrip(start(), { type: 'setTitleText', index: 0, text: 'Monthly orders' });
    expect(t.rules.output.titleRows[0]).toEqual({ text: 'Monthly orders', bold: true });
    expect(t.edited.has('title:0')).toBe(true);
    const added = roundTrip(start(), { type: 'addTitleRow', row: { text: 'Draft' }, at: 0 });
    expect(added.rules.output.titleRows).toHaveLength(3);
    const removed = roundTrip(start(), { type: 'removeTitleRow', index: 1 });
    expect(removed.rules.output.titleRows).toEqual([{ text: 'Orders report', bold: true }]);
    const replaced = roundTrip(start(), { type: 'setTitleRows', rows: [{ blank: true }] });
    expect(replaced.rules.output.titleRows).toEqual([{ blank: true }]);
    const appended = ok(start(), { type: 'setTitleText', index: 2, text: 'Extra' });
    expect(appended.rules.output.titleRows[2]).toEqual({ text: 'Extra' });
    expect(refused(start(), { type: 'setTitleText', index: 9, text: 'x' })[0]!.code).toBe('noSuchItem');
  });

  it('"insert month from [date column]" builds parts: the text, then the month of the latest date', () => {
    const s = roundTrip(start(), { type: 'insertMonthFromDate', index: 0, column: 'shipped' });
    expect(s.rules.output.titleRows[0]).toEqual({
      parts: [{ text: 'Orders report' }, { agg: 'max', column: 'shipped', format: 'MMMM YYYY' }],
      bold: true,
    });
  });

  it('can use the earliest date, another format, a blank row, an empty text, or add a second date', () => {
    const early = ok(start(), { type: 'insertMonthFromDate', index: 0, column: 'shipped', agg: 'min', format: 'MM/YYYY' });
    expect(early.rules.output.titleRows[0]).toMatchObject({ parts: [{ text: 'Orders report' }, { agg: 'min', column: 'shipped', format: 'MM/YYYY' }] });
    const blank = ok(start(), { type: 'insertMonthFromDate', index: 1, column: 'shipped' });
    expect(blank.rules.output.titleRows[1]).toEqual({ parts: [{ agg: 'max', column: 'shipped', format: 'MMMM YYYY' }] });
    const fresh = ok(start(), { type: 'insertMonthFromDate', index: 2, column: 'shipped' });
    expect(fresh.rules.output.titleRows[2]).toEqual({ parts: [{ agg: 'max', column: 'shipped', format: 'MMMM YYYY' }] });
    const twice = ok(early, { type: 'insertMonthFromDate', index: 0, column: 'shipped' });
    expect((twice.rules.output.titleRows[0] as { parts: unknown[] }).parts).toHaveLength(3);
    expectValid(twice.rules as Rules);
  });

  it('needs a date column', () => {
    const p = refused(start(), { type: 'insertMonthFromDate', index: 0, column: 'supplier' });
    expect(p[0]).toMatchObject({ code: 'typeMismatch', message: 'expected date, got text', column: 'supplier' });
    expect(refused(start(), { type: 'insertMonthFromDate', index: 0, column: 'ghost' })[0]!.code).toBe('unknownColumn');
  });
});

describe('sort, groups and summary rows', () => {
  it('sets the sort list', () => {
    const s = roundTrip(start(), { type: 'setSort', keys: [{ column: 'supplier', dir: 'desc' }, { column: 'sku', dir: 'asc' }] });
    expect(s.rules.transform.sort).toHaveLength(2);
    expect(s.edited.has('sort')).toBe(true);
    expect(ok(s, { type: 'setSort', keys: [] }).rules.transform.sort).toEqual([]);
    expect(refused(start(), { type: 'setSort', keys: [{ column: 'ghost', dir: 'asc' }] })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'setSort', keys: [{ column: 'sku', dir: 'asc' }, { column: 'sku', dir: 'desc' }] })[0]!.code).toBe('duplicateKey');
  });

  it('groups by a column with blank rows after, and its own summary rows', () => {
    let s = roundTrip(start(), { type: 'setGroup', group: { by: 'supplier', showDetailRows: true, blankRowsAfter: 1 } });
    expect(s.rules.transform.group).toEqual({ by: 'supplier', showDetailRows: true, blankRowsAfter: 1 });
    expect(s.edited.has('group')).toBe(true);
    s = roundTrip(s, { type: 'addSummaryRow', scope: 'group', row: { label: 'Subtotal', labelColumn: 'Item', cells: { Qty: 'sum', Total: 'sum' } } });
    expect(s.rules.transform.group!.summaryRows).toEqual([{ label: 'Subtotal', labelColumn: 'Item', cells: { Qty: 'sum', Total: 'sum' } }]);
    expect(s.edited.has('summary:group:0')).toBe(true);
    // changing the group keeps its summary rows
    s = ok(s, { type: 'setGroup', group: { by: 'status', showDetailRows: true } });
    expect(s.rules.transform.group!.summaryRows).toHaveLength(1);
    expect(s.rules.transform.group!.blankRowsAfter).toBeUndefined();
    // ...and removing the group removes them
    s = ok(s, { type: 'setGroup', group: null });
    expect(s.rules.transform.group).toBeUndefined();
    expect(refused(start(), { type: 'setGroup', group: { by: 'ghost', showDetailRows: true } })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'setGroup', group: { by: 'sku', showDetailRows: true, blankRowsAfter: 99 } })[0]!.code).toBe('badValue');
  });

  it('adds, edits, removes and replaces the end summary rows', () => {
    const add = roundTrip(start(), { type: 'addSummaryRow', scope: 'end', row: { label: 'Average', cells: { Qty: 'average' } } });
    expect(add.rules.output.summaryRows).toHaveLength(2);
    const upd = roundTrip(start(), { type: 'updateSummaryRow', scope: 'end', index: 0, row: { label: 'Grand total', cells: { Qty: 'sum' } } });
    expect(upd.rules.output.summaryRows![0]).toEqual({ label: 'Grand total', cells: { Qty: 'sum' } });
    const rem = roundTrip(start(), { type: 'removeSummaryRow', scope: 'end', index: 0 });
    expect(rem.rules.output.summaryRows).toBeUndefined();
    const set = roundTrip(start(), { type: 'setSummaryRows', scope: 'end', rows: [{ cells: { Shipped: 'max' } }] });
    expect(set.rules.output.summaryRows).toEqual([{ cells: { Shipped: 'max' } }]);
    expect(refused(start(), { type: 'removeSummaryRow', scope: 'end', index: 3 })[0]!.code).toBe('noSuchItem');
  });

  it('group summary rows need a group', () => {
    expect(refused(start(), { type: 'addSummaryRow', scope: 'group', row: { cells: { Qty: 'sum' } } })[0]!.code).toBe('noGroup');
  });

  it('checks each summary against its column, in the type checker\'s words', () => {
    const p = refused(start(), { type: 'addSummaryRow', scope: 'end', row: { cells: { Supplier: 'sum' } } });
    expect(p[0]).toMatchObject({ code: 'typeMismatch', column: 'Supplier', message: 'sum applies to a numeric column; "Supplier" is text' });
    const forced: Rules = { ...ordersRules(), output: { ...ordersRules().output, summaryRows: [{ cells: { Supplier: 'sum' } }] } };
    expect(typeCheck(forced).map((t) => t.message)).toContain(p[0]!.message);
    expect(refused(start(), { type: 'addSummaryRow', scope: 'end', row: { cells: { Supplier: 'min' } } })[0]!.message).toBe('min applies to a numeric or date column; "Supplier" is text');
    expect(refused(start(), { type: 'addSummaryRow', scope: 'end', row: { cells: { Ghost: 'sum' } } })[0]!.code).toBe('unknownColumn');
    expect(refused(start(), { type: 'addSummaryRow', scope: 'end', row: { labelColumn: 'Ghost', cells: {} } })[0]!.code).toBe('unknownColumn');
    // count, first and last suit any column; min and max suit dates
    ok(start(), { type: 'addSummaryRow', scope: 'end', row: { cells: { Supplier: 'count', Shipped: 'min', Item: 'first' } } });
  });

  it('editing the summary rows of a stored file that still has grandTotal/subtotal migrates it to summaryRows', () => {
    const s0 = start(legacyTotalsRules());
    const before = lineIdsOf(s0.rules);
    expect(before).toContain('summary:end:0');
    expect(before).toContain('summary:group:0');
    const s = roundTrip(s0, { type: 'addSummaryRow', scope: 'end', row: { label: 'Count', cells: { Qty: 'count' } } });
    expect(s.rules.output.grandTotal).toBeUndefined();
    expect(s.rules.output.summaryRows).toEqual([{ label: 'Total', labelColumn: 'Item', cells: { Qty: 'sum', Total: 'sum' } }, { label: 'Count', cells: { Qty: 'count' } }]);
    const g = ok(s0, { type: 'removeSummaryRow', scope: 'group', index: 0 });
    expect(g.rules.transform.group!.subtotal).toBeUndefined();
    expect(g.rules.transform.group!.summaryRows).toBeUndefined();
  });
});

describe('output options', () => {
  it('changes the sheet name, direction, language, header style and file type', () => {
    const s = roundTrip(start(), { type: 'setOutputOptions', patch: { sheetName: 'Q1', direction: 'rtl', language: 'he', headerBold: false, file: { type: 'csv', delimiter: ';' } } });
    expect(s.rules.output).toMatchObject({ sheetName: 'Q1', direction: 'rtl', language: 'he', headerStyle: { bold: false }, file: { type: 'csv', delimiter: ';' } });
    expect(refused(start(), { type: 'setOutputOptions', patch: { sheetName: '' } })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'setOutputOptions', patch: { sheetName: 'a/b' } })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'setOutputOptions', patch: { sheetName: 'x'.repeat(32) } })[0]!.code).toBe('badValue');
  });
});

// ---------- checks, assumptions, functions, tables ----------

describe('validations', () => {
  it('adds, changes and removes a check', () => {
    const add = roundTrip(start(), { type: 'addValidation', validation: { column: 'sku', rule: 'lengthEquals', length: 6, severity: 'block' } });
    expect(add.rules.validations).toHaveLength(3);
    expect(add.edited.has('check:2')).toBe(true);
    const upd = roundTrip(start(), { type: 'updateValidation', index: 0, validation: { column: 'qty', rule: 'range', min: 1, max: 999, severity: 'block' } });
    expect(upd.rules.validations[0]).toMatchObject({ min: 1, max: 999, severity: 'block' });
    const rem = roundTrip(start(), { type: 'removeValidation', index: 0 });
    expect(rem.rules.validations).toHaveLength(1);
    const out = roundTrip(start(), { type: 'addValidation', validation: { on: 'output', column: 'Shipped', rule: 'required', severity: 'flag' } });
    expect(out.rules.validations[2]).toMatchObject({ on: 'output', column: 'Shipped' });
  });

  it('checks that the rule suits the column and that the column exists', () => {
    expect(refused(start(), { type: 'addValidation', validation: { column: 'supplier', rule: 'range', min: 0, severity: 'flag' } })[0]!.message).toBe('range applies to a numeric column; "supplier" is text');
    expect(refused(start(), { type: 'addValidation', validation: { column: 'qty', rule: 'dateRange', from: '2024-01-01', to: '2024-12-31', severity: 'flag' } })[0]!.message).toBe('dateRange applies to a date column; "qty" is integer');
    expect(refused(start(), { type: 'addValidation', validation: { on: 'output', column: 'Ghost', rule: 'required', severity: 'flag' } })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'addValidation', validation: { column: 'ghost', rule: 'required', severity: 'flag' } })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'addValidation', validation: { column: 'qty', rule: 'range', severity: 'nope' as 'flag' } })[0]!.code).toBe('schema');
    expect(refused(start(), { type: 'removeValidation', index: 9 })[0]!.code).toBe('noSuchItem');
  });
});

describe('dismissAssumption (Keep)', () => {
  it('drops the "please check" item', () => {
    const s = roundTrip(start(), { type: 'dismissAssumption', index: 0 });
    expect(s.rules.assumptions).toEqual([]);
    expect(refused(start(), { type: 'dismissAssumption', index: 3 })[0]!.code).toBe('noSuchItem');
  });
});

describe('functions and tables', () => {
  it('defines a function from formula text and uses it in a column', () => {
    let s = roundTrip(start(), { type: 'setFunction', fn: { name: 'netOf', params: [{ name: 'gross', type: 'decimal' }, { name: 'rate', type: 'decimal' }], returns: 'decimal', body: 'round(gross / (1 + rate), 2)' } });
    expect(s.rules.transform.functions).toHaveLength(1);
    expect(s.edited.has('fn:netOf')).toBe(true);
    s = ok(s, { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'netOf(price, 0.17)', type: 'decimal' } });
    expectValid(s.rules as Rules);
    // a function still in use can't be removed
    expect(refused(s, { type: 'removeFunction', name: 'netOf' })[0]!.code).toBe('reference');
    s = ok(s, { type: 'setColumnMethod', index: 2, method: { kind: 'copy', source: 'qty' } });
    expect(ok(s, { type: 'removeFunction', name: 'netOf' }).rules.transform.functions).toBeUndefined();
  });

  it('refuses a body with a column in it, a bad name and a name the formulas already use', () => {
    const fn = { name: 'f', params: [{ name: 'a', type: 'decimal' as const }], returns: 'decimal' as const, body: 'a + 1' };
    expect(refused(start(), { type: 'setFunction', fn: { ...fn, body: 'a + qty' } })[0]!.code).toBe('formula'); // a body only knows its own params
    expect(refused(start(), { type: 'setFunction', fn: { ...fn, body: 'a +' } })[0]!.code).toBe('formula');
    expect(refused(start(), { type: 'setFunction', fn: { ...fn, name: 'not valid' } })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'setFunction', fn: { ...fn, name: 'round' } })[0]!.code).toBe('badValue');
  });

  it('defines a table and looks up in it; a used table is protected; keys must be unique', () => {
    const table = { name: 'rates', columns: ['code', 'rate'], rows: [['A', 0.1], ['B', 0.2]] };
    let s = roundTrip(start(), { type: 'setTable', table });
    expect(s.edited.has('table:rates')).toBe(true);
    s = ok(s, { type: 'setColumnMethod', index: 2, method: { kind: 'formula', formula: 'lookup("rates", supplier, "rate")', type: 'decimal' } });
    expectValid(s.rules as Rules);
    expect(refused(s, { type: 'removeTable', name: 'rates' })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'setTable', table: { ...table, rows: [['A', 1], ['A', 2]] } })[0]!.code).toBe('reference');
    expect(refused(start(), { type: 'removeTable', name: 'zzz' })[0]!.code).toBe('noSuchItem');
  });
});

// ---------- exceptions ----------

describe('one-off exceptions', () => {
  it('are stored beside the rules, sorted and unique, undoable, and never touch the rules', () => {
    const s0 = start();
    let s = ok(s0, { type: 'markException', row: 7 });
    s = ok(s, { type: 'markException', row: 3 });
    expect(s.exceptions).toEqual([3, 7]);
    expect(s.rules).toBe(s0.rules);
    expect(s.dirty).toBe(true);
    expect(s.edited.size).toBe(0);
    expect(applyEdit(s, { type: 'markException', row: 3 }).result).toEqual({ ok: true, changed: false });
    s = ok(s, { type: 'unmarkException', row: 7 });
    expect(s.exceptions).toEqual([3]);
    expect(undo(s).exceptions).toEqual([3, 7]);
    expect(undo(undo(s)).exceptions).toEqual([7]);
    expect(undo(undo(undo(s))).exceptions).toEqual([]);
    expect(undo(undo(undo(s))).dirty).toBe(false);
    expect(applyEdit(s, { type: 'unmarkException', row: 99 }).result).toEqual({ ok: true, changed: false });
  });

  it('start from the saved exceptions and refuse rows that are not rows', () => {
    expect(start(ordersRules(), { exceptions: [5, 2, 5, 0, -1, 1.5] }).exceptions).toEqual([2, 5]);
    expect(refused(start(), { type: 'markException', row: 0 })[0]!.code).toBe('badValue');
    expect(refused(start(), { type: 'markException', row: 1.5 })[0]!.code).toBe('badValue');
  });
});

// ---------- the Advanced view ----------

describe('Advanced JSON', () => {
  it('shows the rules with formulas as text, and saving it back unchanged is nothing', () => {
    const s = start();
    const text = advancedJsonOf(s.rules);
    expect(text).toContain('"expr": "round(qty * price, 2)"');
    expect(text).not.toContain('"args"');
    const out = applyEdit(s, { type: 'setAdvancedJson', text });
    expect(out.result).toEqual({ ok: true, changed: false });
    expect(out.state).toBe(s);
  });

  it('round-trips: edit the text, get the rules; undo takes it back', () => {
    const s = start();
    const edited = advancedJsonOf(s.rules).replace('round(qty * price, 2)', 'round(qty * price * 1.17, 2)').replace('"Orders"', '"Sales"');
    const after = roundTrip(s, { type: 'setAdvancedJson', text: edited });
    expect(after.rules.transform.computed[0]!.expr).toEqual({ op: 'round', digits: 2, arg: { op: 'mul', args: [{ col: 'qty' }, { col: 'price' }, { const: 1.17 }] } });
    expect(after.rules.output.sheetName).toBe('Sales');
    expect(after.edited.has('col:Total')).toBe(true);
    // the text of the new rules reads back to themselves
    expect(applyEdit(after, { type: 'setAdvancedJson', text: advancedJsonOf(after.rules) }).result).toEqual({ ok: true, changed: false });
  });

  it('accepts an if() the blocks cannot make', () => {
    const s = start();
    const edited = advancedJsonOf(s.rules).replace('round(qty * price, 2)', 'if(qty > 10, round(qty * price * 0.9, 2), round(qty * price, 2))');
    const after = roundTrip(s, { type: 'setAdvancedJson', text: edited });
    expect(readColumnMethod(after.rules, 3)).toMatchObject({ kind: 'formula' });
  });

  it('rejects text that is not JSON, or not one object', () => {
    expect(refused(start(), { type: 'setAdvancedJson', text: '{ "schemaVersion": ' })[0]!.code).toBe('json');
    expect(refused(start(), { type: 'setAdvancedJson', text: '[1, 2]' })[0]!.code).toBe('json');
    expect(refused(start(), { type: 'setAdvancedJson', text: '' })[0]!.code).toBe('json');
  });

  it('rejects a formula that does not parse, with the path and the offset', () => {
    const s = start();
    const p = refused(s, { type: 'setAdvancedJson', text: advancedJsonOf(s.rules).replace('round(qty * price, 2)', 'round(qty *') });
    expect(p[0]).toMatchObject({ code: 'formula', path: 'transform.computed[0].expr' });
    expect(typeof p[0]!.offset).toBe('number');
  });

  it('rejects what is not a valid rules file: unknown fields, wrong values, a missing name', () => {
    const s = start();
    const json = JSON.parse(advancedJsonOf(s.rules));
    const withExtra = JSON.stringify({ ...json, surprise: 1 });
    expect(refused(s, { type: 'setAdvancedJson', text: withExtra })[0]!.code).toBe('schema');
    const badEnum = JSON.stringify({ ...json, output: { ...json.output, direction: 'sideways' } });
    expect(refused(s, { type: 'setAdvancedJson', text: badEnum })[0]!.code).toBe('schema');
    const { name: _name, ...noName } = json;
    void _name;
    expect(refused(s, { type: 'setAdvancedJson', text: JSON.stringify(noName) })[0]!.code).toBe('schema');
  });

  it('rejects rules that point at a column that does not exist', () => {
    const s = start();
    const json = JSON.parse(advancedJsonOf(s.rules));
    json.output.columns[0].from = 'ghost';
    const p = refused(s, { type: 'setAdvancedJson', text: JSON.stringify(json) });
    expect(p[0]).toMatchObject({ code: 'reference' });
    expect(p[0]!.message).toContain('ghost');
  });
});

// ---------- the format lock: editing the output side changes the format ----------

describe('formatChange (SPEC 8.12)', () => {
  const inFormat = (rules: Rules = ordersRules()) => start(rules, { format: { sourceCount: 3 } });

  it('is set by an edit of the output side, and says how many sources it reaches', () => {
    const s0 = inFormat();
    expect(s0.format).toEqual({ sourceCount: 3 });
    const edits: EditAction[] = [
      { type: 'setColumnHeader', index: 0, header: 'SKU' },
      { type: 'reorderColumns', from: 0, to: 2 },
      { type: 'addColumn' },
      { type: 'removeColumn', index: 4 },
      { type: 'setColumnFormat', index: 2, format: '0' },
      { type: 'setTitleText', index: 0, text: 'Other' },
      { type: 'setSort', keys: [{ column: 'supplier', dir: 'asc' }] },
      { type: 'addSummaryRow', scope: 'end', row: { cells: { Qty: 'max' } } },
      { type: 'setOutputOptions', patch: { direction: 'rtl' } },
      { type: 'addValidation', validation: { on: 'output', column: 'Qty', rule: 'required', severity: 'flag' } },
      { type: 'setGroup', group: { by: 'supplier', showDetailRows: true } },
    ];
    for (const a of edits) {
      const s = ok(s0, a);
      expect([a.type, s.formatChange]).toEqual([a.type, true]);
      expect([a.type, undo(s).formatChange]).toEqual([a.type, false]);
    }
  });

  it('is not set by an edit of this source only: how a column is made, filters, duplicates, expand, input checks', () => {
    const s0 = inFormat();
    const edits: EditAction[] = [
      { type: 'setColumnMethod', index: 2, method: { kind: 'copy', source: 'price' } },
      { type: 'setColumnMethod', index: 3, method: { kind: 'calculate', terms: [{ column: 'qty' }, { number: 2 }], ops: ['*'] } },
      { type: 'addFilter', filter: { column: 'status', op: 'notEmpty' } },
      { type: 'setDedupe', enabled: true },
      { type: 'addValidation', validation: { column: 'qty', rule: 'required', severity: 'flag' } },
      { type: 'dismissAssumption', index: 0 },
      { type: 'markException', row: 4 },
    ];
    for (const a of edits) {
      const s = ok(s0, a);
      expect([a.type, s.formatChange]).toEqual([a.type, false]);
      expect(s.dirty).toBe(true);
    }
  });

  it('a learn that has just been saved as a format joins it: its next edit of the output side is a format change (no re-check, history kept)', () => {
    let s = ok(start(), { type: 'addFilter', filter: { column: 'status', op: 'notEmpty' } });
    expect(s.format).toBeNull();
    // Saved: what is on screen is what the server has, and the source now belongs to a format.
    s = withFormat(markSaved(s), { sourceCount: 1 });
    const { rev, history } = s;
    expect(s.format).toEqual({ sourceCount: 1 });
    expect([s.dirty, s.formatChange, s.rev]).toEqual([false, false, rev]);
    expect(s.history).toBe(history);
    const renamed = ok(s, { type: 'setColumnHeader', index: 0, header: 'SKU' });
    expect([renamed.dirty, renamed.formatChange]).toEqual([true, true]);
    expect(ok(s, { type: 'addFilter', filter: { column: 'qty', op: 'notEmpty' } }).formatChange).toBe(false);
    // (already changed when it joins: the flag follows)
    expect(withFormat(ok(start(), { type: 'setColumnHeader', index: 0, header: 'SKU' }), { sourceCount: 2 }).formatChange).toBe(true);
    expect(withFormat(renamed, null).formatChange).toBe(false);
  });

  it('a change that changes back is no change; a save writes the change out', () => {
    const s0 = inFormat();
    let s = ok(s0, { type: 'setColumnHeader', index: 0, header: 'SKU' });
    expect(s.formatChange).toBe(true);
    s = ok(s, { type: 'setColumnHeader', index: 0, header: 'Item' });
    expect(s.formatChange).toBe(false);
    s = ok(s, { type: 'setColumnHeader', index: 0, header: 'SKU' });
    s = markSaved(s);
    expect(s.formatChange).toBe(false);
    expect(s.dirty).toBe(false);
    expect(ok(s, { type: 'setColumnHeader', index: 1, header: 'Vendor' }).formatChange).toBe(true);
  });

  it('never applies to a conversion that belongs to no format', () => {
    const s = ok(start(), { type: 'setColumnHeader', index: 0, header: 'SKU' });
    expect(s.formatChange).toBe(false);
  });

  it('the fingerprint agrees with the engine\'s formatOf on what is the same format', () => {
    const base = ordersRules();
    const variants: Rules[] = [
      base,
      { ...base, name: 'Another name' },
      { ...base, transform: { ...base.transform, computed: [] , valueMaps: [] }, output: { ...base.output, columns: base.output.columns.map((c) => (c.from === 'total' ? { ...c, from: 'price' } : c)) } },
      { ...base, input: { ...base.input, rowFilters: [] } },
      { ...base, output: { ...base.output, sheetName: 'Other' } },
      { ...base, output: { ...base.output, columns: [...base.output.columns].reverse() } },
      { ...base, transform: { ...base.transform, sort: [{ column: 'supplier', dir: 'asc' }] } },
      { ...base, transform: { ...base.transform, sort: [{ column: 'sku', dir: 'desc' }] } },
      { ...base, validations: base.validations.filter((v) => v.on !== 'output') },
      { ...base, validations: [...base.validations].reverse() },
      legacyTotalsRules(),
      { ...legacyTotalsRules(), output: { ...legacyTotalsRules().output, grandTotal: { labelColumn: 'sku', label: 'Sum', sum: ['qty'] } } },
      { ...base, output: { ...base.output, summaryRows: [...base.output.summaryRows!, { cells: { Qty: 'max' } }] } },
    ];
    const same = (a: Rules, b: Rules): boolean => JSON.stringify(sortKeys(formatOf(a))) === JSON.stringify(sortKeys(formatOf(b)));
    for (const a of variants) {
      for (const b of variants) {
        expect([formatFingerprint(a) === formatFingerprint(b), a === b ? 'same' : 'pair']).toEqual([same(a, b), a === b ? 'same' : 'pair']);
      }
    }
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

// ---------- edited lines ----------

describe('edited lines ("Edited by you")', () => {
  it('marks the lines that changed, by content, and only those', () => {
    let s = start();
    s = ok(s, { type: 'setColumnMethod', index: 2, method: { kind: 'copy', source: 'price' } });
    s = ok(s, { type: 'setTitleText', index: 0, text: 'Other' });
    s = ok(s, { type: 'setSort', keys: [] });
    expect([...s.edited].sort()).toEqual(['col:Qty', 'title:0']);
  });

  it('a column whose helper column changed is edited; one whose value map changed too', () => {
    let s = ok(start(), { type: 'setColumnMethod', index: 3, method: { kind: 'calculate', terms: [{ column: 'qty' }, { column: 'price' }], ops: ['*'], round: 3 } });
    expect([...s.edited]).toEqual(['col:Total']);
    s = ok(s, { type: 'setColumnMethod', index: 1, method: { kind: 'translate', source: 'supplier', pairs: [{ from: 'Acme', to: 'X' }], onMissing: 'keep' } });
    expect([...s.edited].sort()).toEqual(['col:Supplier', 'col:Total']);
  });

  it('undo clears it, redo brings it back; carried-over lines stay', () => {
    const s0 = start(ordersRules(), { edited: ['col:Item'] });
    expect([...s0.edited]).toEqual(['col:Item']);
    const s1 = ok(s0, { type: 'setTitleText', index: 0, text: 'Other' });
    expect([...s1.edited].sort()).toEqual(['col:Item', 'title:0']);
    expect([...undo(s1).edited]).toEqual(['col:Item']);
    expect([...redo(undo(s1)).edited].sort()).toEqual(['col:Item', 'title:0']);
  });

  it('a reordered column is edited (both neighbours changed); its neighbours are not', () => {
    const s = ok(start(), { type: 'reorderColumns', from: 4, to: 0 });
    expect(s.edited.has('col:Shipped')).toBe(true);
    expect(s.edited.has('col:Supplier')).toBe(false);
    expect(s.edited.has('col:Remarks')).toBe(false);
  });
});

// ---------- history ----------

describe('history', () => {
  it('a step per edit; undo and redo walk it; a new edit clears what could be redone', () => {
    let s = start();
    s = ok(s, { type: 'setTitleText', index: 0, text: 'One' });
    s = ok(s, { type: 'setTitleText', index: 0, text: 'Two' });
    expect(s.history.past).toHaveLength(2);
    s = undo(s);
    expect((s.rules.output.titleRows[0] as { text: string }).text).toBe('One');
    expect(canRedo(s)).toBe(true);
    s = ok(s, { type: 'setTitleText', index: 0, text: 'Three' });
    expect(canRedo(s)).toBe(false);
    expect(undo(undo(undo(s))).rules.output.titleRows[0]).toEqual({ text: 'Orders report', bold: true });
    expect(undo(start())).toEqual(start());
  });

  it('an edit that changes nothing adds no step; a refused edit changes nothing at all', () => {
    const s = start();
    const same = applyEdit(s, { type: 'setSort', keys: s.rules.transform.sort });
    expect(same.result).toEqual({ ok: true, changed: false });
    expect(same.state).toBe(s);
    expect(s.history.past).toHaveLength(0);
  });

  it('is capped', () => {
    let s = start(ordersRules(), { historyCap: 3 });
    for (let i = 0; i < 6; i++) s = ok(s, { type: 'setTitleText', index: 0, text: `T${i}` });
    expect(s.history.past).toHaveLength(3);
    let back = s;
    while (canUndo(back)) back = undo(back);
    expect((back.rules.output.titleRows[0] as { text: string }).text).toBe('T2');
  });

  it('dirty tracks against what is saved: back to the saved rules is clean again', () => {
    let s = start();
    s = ok(s, { type: 'setTitleText', index: 0, text: 'Other' });
    expect(s.dirty).toBe(true);
    expect(undo(s).dirty).toBe(false);
    s = markSaved(s);
    expect(s.dirty).toBe(false);
    expect(undo(s).dirty).toBe(true); // the saved rules are the edited ones now
    expect(s.history.past).toHaveLength(1); // undo still works across a save
  });

  it('every accepted edit bumps rev (what the live check keys on); a refusal does not', () => {
    const s = start();
    const a = ok(s, { type: 'setTitleText', index: 0, text: 'x' });
    expect(a.rev).toBe(s.rev + 1);
    expect(undo(a).rev).toBe(a.rev + 1);
    expect(applyEdit(s, { type: 'setColumnHeader', index: 0, header: '' }).state.rev).toBe(s.rev);
  });
});

// ---------- the limits check on the whole ----------

describe('every accepted edit leaves rules the engine accepts', () => {
  it('passes checkLimits and typeCheck for a run of mixed edits', () => {
    let s = start();
    const steps: EditAction[] = [
      { type: 'addColumn', header: 'Twice', method: { kind: 'calculate', terms: [{ column: 'qty' }, { number: 2 }], ops: ['*'] } },
      { type: 'addColumn', header: 'Label', method: { kind: 'join', columns: ['sku', 'supplier'], separator: ' / ' } },
      { type: 'addColumn', header: 'Code', method: { kind: 'partOfText', source: 'sku', part: 'first', n: 2 } },
      { type: 'addColumn', header: 'Kind', method: { kind: 'fixed', value: 'order' } },
      { type: 'addColumn', header: 'State', method: { kind: 'translate', source: 'status', pairs: [{ from: 'open', to: 'O' }], onMissing: 'flag' } },
      { type: 'setGroup', group: { by: 'supplier', showDetailRows: true, blankRowsAfter: 1 } },
      { type: 'addSummaryRow', scope: 'group', row: { label: 'Subtotal', cells: { Qty: 'sum', Twice: 'sum' } } },
      { type: 'insertMonthFromDate', index: 0, column: 'shipped' },
      { type: 'setDedupe', enabled: true, keys: ['sku'], action: 'remove' },
      { type: 'removeColumn', index: 1 },
      { type: 'reorderColumns', from: 0, to: 3 },
    ];
    for (const a of steps) {
      s = ok(s, a);
      expect(checkLimits(s.rules as Rules, 'paid')).toEqual([]);
      expect(typeCheck(s.rules as Rules)).toEqual([]);
      expectValid(s.rules as Rules);
    }
    // ...and all of it undoes, one step at a time
    for (let i = steps.length - 1; i >= 0; i--) s = undo(s);
    expect(s.rules).toEqual(ordersRules());
    expect(s.dirty).toBe(false);
  });
});

// ---------- the source side: editing the input side changes the SOURCE (SPEC 8.15) ----------

describe('sourceChange (SPEC 8.15)', () => {
  const inSource = (rules: Rules = ordersRules(), formats = 2) => start(rules, { source: { formats } });
  const withInput = (edit: (r: Rules) => void): Rules => {
    const rules = ordersRules();
    edit(rules);
    return rules;
  };

  it('inputSideChanged: the reading options, the input checks and what a declared column says are the input side', () => {
    const base = ordersRules();
    expect(inputSideChanged(base, ordersRules())).toBe(false);
    const changes: [string, (r: Rules) => void][] = [
      ['a column\'s header', (r) => void (r.input.columns[1]!.header = 'Vendor')],
      ['a column\'s type', (r) => void (r.input.columns[2]!.type = 'decimal')],
      ['a column\'s padding', (r) => void (r.input.columns[0]!.padLeft = 8)],
      ['a column\'s date formats', (r) => void (r.input.columns[5]!.inputFormats = ['YYYY-MM-DD'])],
      ['a column\'s aliases', (r) => void (r.input.columns[1]!.aliases = ['Vendor name'])],
      ['what a column reads another way (readAs, SPEC 8.4a)', (r) => void (r.input.columns[2]!.readAs = { 'N/A': '' })],
      ['the sheet', (r) => void (r.input.sheet = { pick: 'name', name: 'Data' })],
      ['the header row', (r) => void (r.input.headerRow = 3)],
      ['where the file stops', (r) => void (r.input.stopAt = { when: 'firstCellEquals', values: ['Total'] } as never)],
      ['an input check', (r) => void r.validations.push({ column: 'qty', rule: 'required', severity: 'flag' })],
      ['a column the rules did not declare', (r) => void r.input.columns.push({ id: 'extra', header: 'Extra', type: 'text' })],
    ];
    for (const [what, edit] of changes) expect([what, inputSideChanged(base, withInput(edit))]).toEqual([what, true]);
  });

  it('inputSideChanged: what is not the source is not a change - the output side, row filters, how a column is made; `required`; a column no longer declared', () => {
    const base = ordersRules();
    const same: [string, (r: Rules) => void][] = [
      ['the output side', (r) => void (r.output.columns[0]!.header = 'SKU')],
      ['a row filter (which rows a FORMAT wants, not how the file is read)', (r) => void r.input.rowFilters!.push({ column: 'qty', op: 'notEmpty' })],
      ['a computed column', (r) => void (r.transform.computed[0]!.id = 'total2')],
      ['an output check', (r) => void r.validations.push({ on: 'output', column: 'Qty', rule: 'required', severity: 'flag' })],
      ['a column being required', (r) => void (r.input.columns[1]!.required = true)],
      ['the order of the aliases', (r) => void (r.input.columns[1]!.aliases = ['b', 'a'])],
      // A source keeps its columns: a conversion may read a subset, so a column the rules stop declaring leaves the source as it was.
      ['a column the rules no longer declare', (r) => void r.input.columns.pop()],
    ];
    for (const [what, edit] of same) {
      const edited = withInput(edit);
      if (what === 'the order of the aliases') {
        // (aliases are a set: the same two in another order is nothing)
        const before = withInput((r) => void (r.input.columns[1]!.aliases = ['a', 'b']));
        expect([what, inputSideChanged(before, edited)]).toEqual([what, false]);
      } else {
        expect([what, inputSideChanged(base, edited)]).toEqual([what, false]);
      }
    }
    // `on: "input"` written out is the same as not written (SPEC 8.8)
    const plain = withInput((r) => void r.validations.push({ column: 'qty', rule: 'required', severity: 'flag' }));
    const explicit = withInput((r) => void r.validations.push({ on: 'input', column: 'qty', rule: 'required', severity: 'flag' }));
    expect(inputSideChanged(plain, explicit)).toBe(false);
  });

  it('is set by an edit of the input side, for a conversion whose source is known; undoing it takes it back', () => {
    const s0 = inSource();
    expect(s0.source).toEqual({ formats: 2 });
    expect(s0.sourceChange).toBe(false);
    const s = ok(s0, { type: 'addValidation', validation: { column: 'qty', rule: 'required', severity: 'flag' } });
    expect(s.sourceChange).toBe(true);
    expect(undo(s).sourceChange).toBe(false);
    // (the same edit also changes nothing of the format)
    expect(s.formatChange).toBe(false);
  });

  it('is not set by an edit of the output side or of the filters, and never without a known source', () => {
    const s0 = inSource();
    for (const a of [
      { type: 'setColumnHeader', index: 0, header: 'SKU' },
      { type: 'addFilter', filter: { column: 'status', op: 'notEmpty' } },
      { type: 'setDedupe', enabled: true },
    ] as EditAction[]) expect([a.type, ok(s0, a).sourceChange]).toEqual([a.type, false]);
    const withoutSource = start();
    expect(withoutSource.source).toBeNull();
    expect(ok(withoutSource, { type: 'addValidation', validation: { column: 'qty', rule: 'required', severity: 'flag' } }).sourceChange).toBe(false);
  });

  it('a save writes the change out; a source that becomes known later (a learn just saved) joins without touching rev or history', () => {
    let s = ok(inSource(), { type: 'addValidation', validation: { column: 'qty', rule: 'required', severity: 'flag' } });
    expect(s.sourceChange).toBe(true);
    s = markSaved(s);
    expect([s.dirty, s.sourceChange]).toEqual([false, false]);

    let learned = ok(start(), { type: 'addValidation', validation: { column: 'qty', rule: 'required', severity: 'flag' } });
    learned = markSaved(learned);
    const { rev, history } = learned;
    const joined = withSource(learned, { formats: 3 });
    expect(joined.source).toEqual({ formats: 3 });
    expect([joined.sourceChange, joined.rev]).toEqual([false, rev]);
    expect(joined.history).toBe(history);
    const edited = ok(joined, { type: 'removeValidation', index: 0 });
    expect(edited.sourceChange).toBe(true);
    // ... and it is forgotten when the source is no longer known
    expect(withSource(edited, null).sourceChange).toBe(false);
  });
});
