// The deep analysis with AI works while the user may keep editing other fields: its answer is merged with those edits (`mergeRules`), and
// the fields it works on - plus the shape of the columns - are read-only meanwhile (`lockProblem`, `EditorStore.setLock`).
import { describe, expect, it } from 'vitest';
import { lockProblem } from './lock';
import { mergeRules } from './merge';
import { EditorStore } from './store';
import { ordersRules } from './testkit';
import type { EditableRules } from './types';

/** The orders rules as the free engine leaves them: Total and Shipped have no rule, no computed columns, no summary row. */
function base(): EditableRules {
  const rules = ordersRules();
  rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' || c.header === 'Shipped' ? { header: c.header, from: null } : c));
  rules.transform.computed = [];
  rules.output.summaryRows = [];
  rules.unsupported = [];
  return rules;
}

/** What the AI step makes of it: Total and Shipped get a rule (and the computed column Total reads), and a summary row is built. */
function answer(from: EditableRules): EditableRules {
  const full = ordersRules();
  const next = structuredClone(from);
  next.transform.computed = full.transform.computed;
  next.output.columns = next.output.columns.map((c) => (c.header === 'Total' ? { ...c, from: 'total' } : c.header === 'Shipped' ? { ...c, from: 'shipped' } : c));
  next.output.summaryRows = full.output.summaryRows;
  return next;
}

describe('mergeRules', () => {
  it('the user changed nothing: the answer, as it is', () => {
    const b = base();
    const t = answer(b);
    expect(mergeRules(b, structuredClone(b), t)).toEqual(t);
  });

  it('keeps an edit of another field and takes what the answer made', () => {
    const b = base();
    const o = structuredClone(b);
    o.output.columns[1] = { ...o.output.columns[1]!, header: 'Vendor' };
    const t = answer(b);
    const merged = mergeRules(b, o, t)!;
    expect(merged.output.columns.map((c) => c.header)).toEqual(['Item', 'Vendor', 'Qty', 'Total', 'Shipped', 'Remarks']);
    expect(merged.output.columns.find((c) => c.header === 'Total')!.from).toBe('total');
    expect(merged.output.columns.find((c) => c.header === 'Shipped')!.from).toBe('shipped');
    expect(merged.transform.computed).toEqual(t.transform.computed);
    expect(merged.output.summaryRows).toEqual(t.output.summaryRows);
  });

  it('matches lists of things with an id by it: a column the user declared and one the answer declared both stay', () => {
    const b = base();
    const o = structuredClone(b);
    o.input.columns = [...o.input.columns, { ...o.input.columns[0]!, id: 'mine', header: 'Mine' }];
    const t = structuredClone(b);
    t.input.columns = [...t.input.columns, { ...t.input.columns[0]!, id: 'theirs', header: 'Theirs' }];
    const merged = mergeRules(b, o, t)!;
    expect(merged.input.columns.map((c) => c.id)).toEqual([...b.input.columns.map((c) => c.id), 'mine', 'theirs']);
  });

  it('a column the user removed (and the answer left alone) stays removed', () => {
    const b = base();
    const o = structuredClone(b);
    o.input.columns = o.input.columns.slice(1);
    const merged = mergeRules(b, o, structuredClone(b))!;
    expect(merged.input.columns).toEqual(o.input.columns);
  });

  it('both changed the same thing differently: a conflict (null), so the caller keeps the user\'s rules', () => {
    const b = base();
    const o = structuredClone(b);
    o.output.summaryRows = [{ label: 'Mine', cells: {} } as never];
    const t = answer(b);
    expect(mergeRules(b, o, t)).toBeNull();
  });

  it('a change of the number of columns on one side and a change of the same list on the other is a conflict, not a guess', () => {
    const b = base();
    const o = structuredClone(b);
    o.output.columns = [...o.output.columns, { header: 'Extra', from: null }];
    expect(mergeRules(b, o, answer(b))).toBeNull();
  });

  it('the same change on both sides is no conflict', () => {
    const b = base();
    const o = answer(b);
    expect(mergeRules(b, o, answer(b))).toEqual(o);
  });

  // The lists with no id or name (the audit's case: while the AI works on one column, the user fills another by hand) are matched by what
  // their entries are about, so both sides changing their length is no conflict.
  it('unsupported columns are matched by their output column: the user filled one by hand, the answer reported another - both stay', () => {
    const b: EditableRules = { ...base(), unsupported: [{ outputColumn: 'Remarks', reasonCode: 'externalData' }] };
    const o = structuredClone(b);
    o.output.columns = o.output.columns.map((c) => (c.header === 'Remarks' ? { ...c, from: 'note' } : c));
    o.unsupported = [];
    const t = answer(b);
    t.output.columns = t.output.columns.map((c) => (c.header === 'Shipped' ? { header: 'Shipped', from: null } : c));
    t.unsupported = [...t.unsupported, { outputColumn: 'Shipped', reasonCode: 'externalData' }];
    const merged = mergeRules(b, o, t)!;
    expect(merged).not.toBeNull();
    expect(merged.unsupported).toEqual([{ outputColumn: 'Shipped', reasonCode: 'externalData' }]);
    expect(merged.output.columns.find((c) => c.header === 'Remarks')?.from).toBe('note');
    expect(merged.output.columns.find((c) => c.header === 'Total')?.from).toBe('total');
  });

  it('... and the same column changed differently on both sides is still a conflict', () => {
    const b: EditableRules = { ...base(), unsupported: [{ outputColumn: 'Remarks', reasonCode: 'externalData' }] };
    const o = structuredClone(b);
    o.unsupported = [{ outputColumn: 'Remarks', reasonCode: 'noRelation' as never }];
    const t = structuredClone(b);
    t.unsupported = [{ outputColumn: 'Remarks', reasonCode: 'ambiguous' as never }];
    expect(mergeRules(b, o, t)).toBeNull();
  });

  it('assumptions are matched by output column and reason: one gone on one side, one added on the other - no conflict', () => {
    const b: EditableRules = { ...base(), assumptions: [{ outputColumn: 'Qty', reasonCode: 'dateFormat' as never }] };
    const o = structuredClone(b);
    o.assumptions = [];
    const t = structuredClone(b);
    t.assumptions = [...t.assumptions, { outputColumn: 'Total', reasonCode: 'rounding' as never }, { reasonCode: 'sortGuessed' as never }];
    expect(mergeRules(b, o, t)!.assumptions).toEqual([{ outputColumn: 'Total', reasonCode: 'rounding' }, { reasonCode: 'sortGuessed' }]);
  });

  it('checks are matched by what they say: a check the user added and one the answer added both stay; one the user removed stays removed', () => {
    const b: EditableRules = { ...base(), validations: [{ column: 'qty', rule: 'required', severity: 'flag' }, { column: 'sku', rule: 'unique', severity: 'block' }] };
    const o = structuredClone(b);
    o.validations = [{ severity: 'flag', rule: 'required', column: 'qty' }, { column: 'price', rule: 'range', min: 0, severity: 'flag' }];
    const t = structuredClone(b);
    t.validations = [...t.validations, { on: 'output', column: 'Total', rule: 'required', severity: 'flag' }];
    expect(mergeRules(b, o, t)!.validations).toEqual([
      { severity: 'flag', rule: 'required', column: 'qty' },
      { column: 'price', rule: 'range', min: 0, severity: 'flag' },
      { on: 'output', column: 'Total', rule: 'required', severity: 'flag' },
    ]);
  });
});

describe('lockProblem', () => {
  const rules = base();
  const lock = { columns: new Set(['Total', 'Shipped']), parts: new Set(['summaryRows' as const]) };

  it('refuses an edit of a field it works on, by the header at that position', () => {
    const i = rules.output.columns.findIndex((c) => c.header === 'Total');
    expect(lockProblem({ type: 'setColumnHeader', index: i, header: 'Sum' }, rules, lock)).toMatchObject({ code: 'locked', column: 'Total' });
    expect(lockProblem({ type: 'setColumnMethod', index: i, method: { kind: 'empty' } }, rules, lock)?.code).toBe('locked');
    expect(lockProblem({ type: 'setColumnHeader', index: 0, header: 'Sku' }, rules, lock)).toBeNull();
  });

  it('refuses the shape of the columns and the Advanced text, whatever the column', () => {
    for (const action of [{ type: 'addColumn' }, { type: 'removeColumn', index: 0 }, { type: 'reorderColumns', from: 0, to: 1 }, { type: 'setAdvancedJson', text: '{}' }] as const) {
      expect(lockProblem(action, rules, lock)?.code).toBe('locked');
    }
  });

  it('refuses the layout parts it works on and lets the others through', () => {
    expect(lockProblem({ type: 'addSummaryRow', scope: 'end', row: { label: 'x', cells: {} } as never }, rules, lock)?.code).toBe('locked');
    expect(lockProblem({ type: 'setSort', keys: [] }, rules, lock)).toBeNull();
    expect(lockProblem({ type: 'setOutputOptions', patch: { sheetName: 'Orders' } }, rules, lock)).toBeNull();
  });

  it('a whole learn locks everything', () => {
    expect(lockProblem({ type: 'setSort', keys: [] }, rules, { columns: new Set(), parts: new Set(), whole: true })?.code).toBe('locked');
  });
});

describe('EditorStore.setLock', () => {
  it('answers a refused edit with the problem and leaves the rules (and undo) as they were; unlocking lets edits through again', () => {
    const store = new EditorStore(base());
    const i = store.getState().rules.output.columns.findIndex((c) => c.header === 'Total');
    store.setLock({ columns: new Set(['Total']), parts: new Set() });
    const refused = store.apply({ type: 'setColumnHeader', index: i, header: 'Sum' });
    expect(refused).toMatchObject({ ok: false, problems: [{ code: 'locked' }] });
    expect(store.getState().rules.output.columns[i]!.header).toBe('Total');
    expect(store.getState().rev).toBe(0);
    // an edit of something else goes through; undo is paused meanwhile
    expect(store.apply({ type: 'setColumnHeader', index: 0, header: 'Sku' }).ok).toBe(true);
    store.undo();
    expect(store.getState().rules.output.columns[0]!.header).toBe('Sku');
    store.setLock(null);
    store.undo();
    expect(store.getState().rules.output.columns[0]!.header).toBe('Item');
    expect(store.apply({ type: 'setColumnHeader', index: i, header: 'Sum' }).ok).toBe(true);
  });
});
