// Input columns of the example that no rule uses yet (SPEC 8.11): a learned rules file declares only the input columns it
// reads, so a column such as an ID number that nothing uses was missing from every "source column" dropdown. The editor is
// given the example input's columns; `sourceOptions` offers the undeclared ones (kind `available`), and an edit that uses
// one declares it first, in the same undoable step.
import type { InputColumn, Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { applyEdit, applyColumnMethod, availableInputs, canUndo, createEditorState, readColumnMethod, redo, sourceOptions, undo, type EditAction, type EditorState, type ExampleInputColumn } from './model';
import { computeSaveStatus, metaStatusOf } from './saveStatus';
import { ordersRules } from './testkit';

/** The orders example's input has these too, and no rule uses them. */
const EXAMPLE_INPUT: ExampleInputColumn[] = [
  { header: 'Item', type: 'idLike' },
  { header: 'Supplier', type: 'text' },
  // A Hebrew header (no id can be made from it), a 9-digit ID whose leading zeros were lost.
  { header: 'ת.ז.', type: 'idLike', israeliId: true, leadingZerosLost: true, maxLength: 9 },
  { header: 'Customer name', type: 'text' },
  { header: 'Ship date', type: 'date', serialDates: true, dateFormat: 'excel' },
  { header: 'Amount', type: 'decimal' },
];

const start = (): EditorState => createEditorState(ordersRules());
const inputColumn = (rules: { input: { columns: InputColumn[] } }, header: string): InputColumn | undefined => rules.input.columns.find((c) => c.header === header);

function edit(state: EditorState, action: EditAction): EditorState {
  const { state: next, result } = applyEdit(state, action, { available: EXAMPLE_INPUT });
  if (!result.ok) throw new Error(`edit failed: ${JSON.stringify(result.problems)}`);
  return next;
}

describe('sourceOptions with the example input', () => {
  it('lists every example column that no input column declares, after the declared ones, labelled by its header', () => {
    const options = sourceOptions(ordersRules(), { exampleInput: EXAMPLE_INPUT });
    const available = options.filter((o) => o.kind === 'available');
    expect(available.map((o) => o.label)).toEqual(['ת.ז.', 'Customer name', 'Ship date', 'Amount']);
    // The declared ones (Item, Supplier) are not offered twice, and the available ones come last.
    expect(options.map((o) => o.kind).lastIndexOf('input')).toBeLessThan(options.findIndex((o) => o.kind === 'available'));
    expect(options.filter((o) => o.label === 'Item')).toHaveLength(1);
  });

  it('gives each a fresh camelCase id: from the header when it has latin letters, else c<position>', () => {
    const ids = Object.fromEntries(sourceOptions(ordersRules(), { exampleInput: EXAMPLE_INPUT }).filter((o) => o.kind === 'available').map((o) => [o.label, o.id]));
    expect(ids).toEqual({ 'ת.ז.': 'c3', 'Customer name': 'customerName', 'Ship date': 'shipDate', Amount: 'amount' });
  });

  it('maps the profile to a type: ids stay ids, dates read as dates, numbers as numbers', () => {
    const types = Object.fromEntries(sourceOptions(ordersRules(), { exampleInput: EXAMPLE_INPUT }).filter((o) => o.kind === 'available').map((o) => [o.label, o.type]));
    expect(types).toEqual({ 'ת.ז.': 'idLike', 'Customer name': 'text', 'Ship date': 'date', Amount: 'decimal' });
  });

  it('does not offer a column whose header is declared, however it is spaced or cased; skips blank headers and repeats', () => {
    const rules = ordersRules();
    const options = sourceOptions(rules, {
      exampleInput: [
        { header: '  unit   PRICE ', type: 'decimal' },
        { header: '', type: 'text' },
        { header: 'Notes', type: 'text' },
        { header: 'notes ', type: 'text' },
      ],
    });
    expect(options.filter((o) => o.kind === 'available').map((o) => o.label)).toEqual(['Notes']);
  });

  it('an id never collides with an id the rules already use', () => {
    const rules = ordersRules();
    // `total` is a computed id and `qty` an input id; both slugs are taken, so the new ones get a number.
    const list = availableInputs(rules, [
      { header: 'Total', type: 'decimal' },
      { header: 'QTY!', type: 'integer' },
    ]);
    expect(list.map((a) => a.id)).toEqual(['total2', 'qty2']);
  });

  it('offers nothing without an example input', () => {
    expect(sourceOptions(ordersRules()).some((o) => o.kind === 'available')).toBe(false);
    expect(sourceOptions(ordersRules(), { exampleInput: [] }).some((o) => o.kind === 'available')).toBe(false);
  });
});

describe('choosing a column that no rule declares yet', () => {
  it('declares it (header exactly as in the file, its type, padded to 9) and joins it with a name - one undo step takes both back', () => {
    const before = start();
    const id = sourceOptions(before.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'ת.ז.')!.id;
    const next = edit(before, {
      type: 'addColumn',
      header: 'ID and name',
      method: { kind: 'join', columns: [id, 'supplier'], separator: ' - ' },
    });

    expect(inputColumn(next.rules, 'ת.ז.')).toEqual({ id: 'c3', header: 'ת.ז.', type: 'idLike', padLeft: 9 });
    const col = next.rules.output.columns.at(-1)!;
    const computed = next.rules.transform.computed.find((c) => c.id === col.from)!;
    expect(computed.expr).toEqual({ op: 'concat', args: [{ col: 'c3' }, { const: ' - ' }, { col: 'supplier' }] });
    expect(readColumnMethod(next.rules, next.rules.output.columns.length - 1)).toEqual({ kind: 'join', columns: ['c3', 'supplier'], separator: ' - ' });
    // Only the one it used is declared.
    expect(inputColumn(next.rules, 'Customer name')).toBeUndefined();
    expect(next.rules.input.columns).toHaveLength(before.rules.input.columns.length + 1);

    // One undoable edit: undo removes the column AND its declaration; redo brings both back.
    const undone = undo(next);
    expect(undone.rules).toBe(before.rules);
    expect(inputColumn(undone.rules, 'ת.ז.')).toBeUndefined();
    const redone = redo(undone);
    expect(inputColumn(redone.rules, 'ת.ז.')).toBeDefined();
    expect(redone.rules.output.columns.at(-1)!.header).toBe('ID and name');
  });

  it('copies it as it is (a plain copy reads the declared column)', () => {
    const before = start();
    const id = sourceOptions(before.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Amount')!.id;
    const next = edit(before, { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: id } });
    expect(next.rules.output.columns[5]).toMatchObject({ header: 'Remarks', from: 'amount' });
    expect(inputColumn(next.rules, 'Amount')).toEqual({ id: 'amount', header: 'Amount', type: 'decimal' });
    expect(canUndo(next)).toBe(true);
    expect(undo(next).rules.input.columns).toHaveLength(before.rules.input.columns.length);
  });

  it('a date stored as serial numbers gets the serial format among its input formats', () => {
    const before = start();
    const id = sourceOptions(before.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Ship date')!.id;
    const next = edit(before, { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: id } });
    expect(inputColumn(next.rules, 'Ship date')).toEqual({ id: 'shipDate', header: 'Ship date', type: 'date', inputFormats: ['excelSerial'] });
  });

  it('a calculation, part of text and a translation can read it too', () => {
    let state = start();
    const amount = sourceOptions(state.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Amount')!.id;
    state = edit(state, { type: 'setColumnMethod', index: 5, method: { kind: 'calculate', terms: [{ column: amount }, { number: 2 }], ops: ['*'], round: 2 } });
    expect(inputColumn(state.rules, 'Amount')).toBeDefined();
    const name = sourceOptions(state.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Customer name')!.id;
    state = edit(state, { type: 'setColumnMethod', index: 5, method: { kind: 'partOfText', source: name, part: 'first', n: 3 } });
    expect(inputColumn(state.rules, 'Customer name')).toBeDefined();
    state = edit(state, { type: 'setColumnMethod', index: 5, method: { kind: 'translate', source: name, pairs: [{ from: 'a', to: 'b' }], onMissing: 'keep' } });
    expect(readColumnMethod(state.rules, 5)).toMatchObject({ kind: 'translate', source: 'customerName' });
  });

  it('filters, dedupe keys, sort, group, checks and title months can name it', () => {
    const rules0 = ordersRules();
    const opts = sourceOptions(rules0, { exampleInput: EXAMPLE_INPUT });
    const id = (label: string): string => opts.find((o) => o.label === label)!.id;
    const declared = (state: EditorState, header: string): boolean => inputColumn(state.rules, header) !== undefined;

    let s = edit(start(), { type: 'addFilter', filter: { column: id('ת.ז.'), op: 'notEmpty' } });
    expect(declared(s, 'ת.ז.')).toBe(true);
    expect(s.rules.input.rowFilters?.at(-1)).toEqual({ column: 'c3', op: 'notEmpty' });

    s = edit(start(), { type: 'setDedupe', enabled: true, keys: [id('ת.ז.')], keep: 'first', action: 'flag' });
    expect(declared(s, 'ת.ז.')).toBe(true);

    s = edit(start(), { type: 'setSort', keys: [{ column: id('Customer name'), dir: 'asc' }] });
    expect(declared(s, 'Customer name')).toBe(true);

    s = edit(start(), { type: 'setGroup', group: { by: id('Customer name'), showDetailRows: true } });
    expect(declared(s, 'Customer name')).toBe(true);

    s = edit(start(), { type: 'addValidation', validation: { column: id('ת.ז.'), rule: 'israeliIdChecksum', severity: 'flag' } });
    expect(declared(s, 'ת.ז.')).toBe(true);

    s = edit(start(), { type: 'insertMonthFromDate', index: 0, column: id('Ship date') });
    expect(declared(s, 'Ship date')).toBe(true);
    expect(canUndo(s)).toBe(true);
    expect(undo(s).rules).toEqual(start().rules);
  });

  it('an edit that uses none of them declares none (and text that looks like an id is not one)', () => {
    let s = edit(start(), { type: 'setColumnHeader', index: 0, header: 'Article' });
    expect(s.rules.input.columns).toEqual(ordersRules().input.columns);
    // A filter VALUE that spells a candidate id ("c3") is a value, not a use of the column.
    s = edit(s, { type: 'addFilter', filter: { column: 'status', op: 'eq', value: 'c3' } });
    expect(s.rules.input.columns).toEqual(ordersRules().input.columns);
  });

  it('an id that is neither declared nor offered is still an unknown column', () => {
    const { result } = applyEdit(start(), { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: 'nothingHere' } }, { available: EXAMPLE_INPUT });
    expect(result).toMatchObject({ ok: false, problems: [{ code: 'unknownColumn' }] });
    // ...and without the example input a column of it is not known either.
    const id = sourceOptions(ordersRules(), { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Amount')!.id;
    expect(applyEdit(start(), { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: id } }).result.ok).toBe(false);
  });

  it('the same columns are declared once, with the same ids, whichever is chosen first', () => {
    let s = start();
    const amount = sourceOptions(s.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Amount')!.id;
    const name = sourceOptions(s.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Customer name')!.id;
    s = edit(s, { type: 'setColumnMethod', index: 5, method: { kind: 'copy', source: name } });
    // Amount is still offered under the id it was offered with.
    expect(sourceOptions(s.rules, { exampleInput: EXAMPLE_INPUT }).find((o) => o.label === 'Amount')!.id).toBe(amount);
    s = edit(s, { type: 'addColumn', header: 'Two', method: { kind: 'copy', source: amount } });
    expect(s.rules.input.columns.filter((c) => c.header === 'Amount' || c.header === 'Customer name')).toHaveLength(2);
  });

  it('a typed-in column (a source without example files) works the same way', () => {
    const typed: ExampleInputColumn[] = [{ header: 'ת.ז.', type: 'idLike' }];
    const before = start();
    const id = availableInputs(before.rules, typed)[0]!.id;
    const { state, result } = applyEdit(before, { type: 'addFilter', filter: { column: id, op: 'notEmpty' } }, { available: typed });
    expect(result.ok).toBe(true);
    expect(inputColumn(state.rules, 'ת.ז.')).toEqual({ id: 'c1', header: 'ת.ז.', type: 'idLike' });
  });
});

describe('Join text with fixed text', () => {
  it('joins columns with a separator and optional text before and after, and reads it back', () => {
    const rules: Rules = ordersRules();
    const out = applyColumnMethod(rules, 5, { kind: 'join', columns: ['sku', 'supplier'], separator: ' / ', before: 'ID: ', after: '.' });
    expect(Array.isArray(out)).toBe(false);
    const next = out as Rules;
    const computed = next.transform.computed.find((c) => c.id === next.output.columns[5]!.from)!;
    expect(computed.expr).toEqual({ op: 'concat', args: [{ const: 'ID: ' }, { col: 'sku' }, { const: ' / ' }, { col: 'supplier' }, { const: '.' }] });
    expect(readColumnMethod(next, 5)).toEqual({ kind: 'join', columns: ['sku', 'supplier'], separator: ' / ', before: 'ID: ', after: '.' });
  });

  it('a join with no fixed text reads back exactly as before', () => {
    const out = applyColumnMethod(ordersRules(), 5, { kind: 'join', columns: ['sku', 'supplier'], separator: ' ' }) as Rules;
    expect(readColumnMethod(out, 5)).toEqual({ kind: 'join', columns: ['sku', 'supplier'], separator: ' ' });
  });

  it('only fixed text before, and a separator that is empty', () => {
    const out = applyColumnMethod(ordersRules(), 5, { kind: 'join', columns: ['sku', 'qty'], separator: '', before: '#' }) as Rules;
    expect(readColumnMethod(out, 5)).toEqual({ kind: 'join', columns: ['sku', 'qty'], separator: '', before: '#' });
  });
});

describe('the save status of a result whose only open columns need your input', () => {
  const verified = { verified: true, matched: 30, total: 30, differences: 0 } as never;
  const inputs = { rules: ordersRules(), staticProblems: [], hasExample: true, fullCheck: verified };

  it('says "needs your input" for the columns left out, not "N differences", and saves as userConfirmed', () => {
    const status = computeSaveStatus({ ...inputs, excludedColumns: 2, comparedColumns: 4 });
    expect(status).toEqual({ kind: 'needsInput', columns: 2 });
    expect(metaStatusOf(status)).toBe('userConfirmed');
  });

  it('says it too when nothing at all could be compared', () => {
    const none = { verified: false, matched: 0, total: 0, differences: 1 } as never;
    expect(computeSaveStatus({ ...inputs, fullCheck: none, excludedColumns: 3, comparedColumns: 0 })).toEqual({ kind: 'needsInput', columns: 3 });
  });

  it('still reports real differences among the columns that were compared', () => {
    const differing = { verified: false, matched: 25, total: 30, differences: 5 } as never;
    expect(computeSaveStatus({ ...inputs, fullCheck: differing, excludedColumns: 1, comparedColumns: 5 })).toEqual({ kind: 'differences', differences: 5 });
  });

  it('is plain "verified" when nothing was left out', () => {
    expect(computeSaveStatus({ ...inputs, excludedColumns: 0, comparedColumns: 6 })).toEqual({ kind: 'verified' });
    expect(computeSaveStatus(inputs)).toEqual({ kind: 'verified' });
  });
});
