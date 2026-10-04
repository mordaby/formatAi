// Applying a reading to rules (SPEC 21 v12 item 11): the fragment is merged by HEADER (the rules' own ids may differ from the fragment's), ids
// stay unique, the old rule's computed column goes when nothing reads it, and the question's marker (the check) is the question's state.
import type { AmbiguousColumn } from '@formatai/engine';
import type { LearnResult, Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { applyReading, isReadingCheck, questionOpen, withOpenQuestion } from './readings';
import { EditorStore } from './store';

const CHECK: Validation = { on: 'output', column: 'Branch', rule: 'oneOf', values: ['00'], severity: 'flag' };

/** "00" or the first 2 characters of Employee: the readings the engine returns, in the ids of a fragment of their own. */
const COLUMN: AmbiguousColumn = {
  out: 1,
  header: 'Branch',
  value: '00',
  defaultReading: 1,
  check: CHECK,
  readings: [
    { kind: 'constant', columns: [], fragment: { from: 'branch', inputColumns: [], computed: [{ id: 'branch', type: 'text', expr: { const: '00' } }], valueMaps: [] } },
    {
      kind: 'substr',
      columns: ['Employee'],
      fragment: {
        from: 'branch',
        inputColumns: [{ id: 'employee', header: 'Employee', type: 'idLike' }],
        computed: [{ id: 'branch', type: 'text', expr: { op: 'substr', arg: { col: 'employee' }, start: 1, length: 2 } }],
        valueMaps: [],
      },
    },
  ],
};

/** Rules whose ids are not the fragment's (an AI answer names things its own way). */
function rules(over: Partial<LearnResult['transform']> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'ref', header: 'Ref', type: 'text' }, { id: 'emp', header: 'employee', type: 'text' }] },
    transform: { computed: [{ id: 'branchValue', type: 'text', expr: { op: 'substr', arg: { col: 'emp' }, start: 1, length: 2 } }], valueMaps: [], sort: [], ...over },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Ref', from: 'ref' },
        { header: 'Branch', from: 'branchValue' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

describe('applyReading', () => {
  it('an answer replaces the rule: the constant is written, the old computed column goes, the marker comes out', () => {
    const open = applyReading(rules(), COLUMN, 1, true)!;
    expect(questionOpen(open, COLUMN)).toBe(true);
    const answered = applyReading(open, COLUMN, 0, false)!;
    expect(questionOpen(answered, COLUMN)).toBe(false);
    const from = answered.output.columns[1]!.from;
    expect(answered.transform.computed).toEqual([{ id: from, type: 'text', expr: { const: '00' } }]);
    expect(answered.validations).toEqual([]);
  });

  it('the data reading is matched to the rules\' own input column by header (another id, another case) - nothing is declared twice', () => {
    const next = applyReading(rules({ computed: [{ id: 'branchValue', type: 'text', expr: { const: '00' } }] }), COLUMN, 1, false)!;
    expect(next.input.columns.map((c) => c.id)).toEqual(['ref', 'emp']);
    const from = next.output.columns[1]!.from;
    expect(next.transform.computed.find((c) => c.id === from)?.expr).toEqual({ op: 'substr', arg: { col: 'emp' }, start: 1, length: 2 });
    // (the old constant is not read by anything any more)
    expect(next.transform.computed.map((c) => c.id)).toEqual([from]);
  });

  it('an input column the rules do not declare is declared, with an id that is free', () => {
    const base = rules();
    const without = { ...base, input: { ...base.input, columns: [base.input.columns[0]!] }, transform: { ...base.transform, computed: [{ id: 'employee', type: 'text' as const, expr: { const: 'x' } }] } };
    const next = applyReading(without, COLUMN, 1, false)!;
    // "employee" is taken (by a computed column), so the declared column gets another id
    expect(next.input.columns.map((c) => c.header)).toEqual(['Ref', 'Employee']);
    const declared = next.input.columns[1]!.id;
    expect(declared).not.toBe('employee');
    const from = next.output.columns[1]!.from;
    expect(next.transform.computed.find((c) => c.id === from)?.expr).toMatchObject({ arg: { col: declared } });
  });

  it('the rule the column already has is kept as it is: only the marker changes (no new ids)', () => {
    const base = rules();
    const open = applyReading(base, COLUMN, 1, true)!;
    expect(open.transform.computed).toBe(base.transform.computed);
    expect(open.validations).toEqual([CHECK]);
    const closed = applyReading(open, COLUMN, 1, false)!;
    expect(closed.transform.computed).toBe(base.transform.computed);
    expect(closed.validations).toEqual([]);
  });

  it('an unsupported note for the column goes (it has a rule now)', () => {
    const base = { ...rules(), unsupported: [{ outputColumn: 'Branch', reasonCode: 'externalData' as const }, { outputColumn: 'Other', reasonCode: 'externalData' as const }] };
    expect(applyReading(base, COLUMN, 1, true)!.unsupported).toEqual([{ outputColumn: 'Other', reasonCode: 'externalData' }]);
  });

  it('refuses when the rules read the fragment\'s column another way (a date where it needs text) or have no such column', () => {
    const base = rules();
    const asDate = { ...base, input: { ...base.input, columns: [base.input.columns[0]!, { id: 'emp', header: 'Employee', type: 'date' as const }] } };
    expect(applyReading(asDate, COLUMN, 1, false)).toBeNull();
    expect(applyReading(base, { ...COLUMN, header: 'Nope' }, 1, false)).toBeNull();
    expect(applyReading(base, COLUMN, 7, false)).toBeNull();
  });

  it('is one undoable edit that the editor accepts (replaceRules), and the question is back after undo', () => {
    const store = new EditorStore(withOpenQuestion(rules({ computed: [{ id: 'branchValue', type: 'text', expr: { const: '00' } }] }), COLUMN)!);
    expect(questionOpen(store.getState().rules, COLUMN)).toBe(true);
    const result = store.apply({ type: 'replaceRules', rules: applyReading(store.getState().rules, COLUMN, 0, false)! });
    expect(result).toEqual({ ok: true, changed: true });
    expect(questionOpen(store.getState().rules, COLUMN)).toBe(false);
    store.undo();
    expect(questionOpen(store.getState().rules, COLUMN)).toBe(true);
  });

  it('a replacement that breaks the rules is refused like any edit', () => {
    const store = new EditorStore(rules());
    const broken = { ...rules(), output: { ...rules().output, columns: [{ header: 'Ref', from: 'nope' }] } };
    const result = store.apply({ type: 'replaceRules', rules: broken });
    expect(result.ok).toBe(false);
  });
});

describe('isReadingCheck', () => {
  it('recognises the check whatever the order of its keys', () => {
    expect(isReadingCheck({ severity: 'flag', values: ['00'], rule: 'oneOf', column: 'Branch', on: 'output' }, COLUMN)).toBe(true);
    expect(isReadingCheck({ on: 'output', column: 'Branch', rule: 'oneOf', values: ['01'], severity: 'flag' }, COLUMN)).toBe(false);
    expect(isReadingCheck(CHECK, { check: null })).toBe(false);
  });
});
