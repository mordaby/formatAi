// Applying a reading to rules (SPEC 21 v12 item 11): the fragment is merged by HEADER (the rules' own ids may differ from the fragment's), ids
// stay unique, the old rule's computed column goes when nothing reads it, and the question's marker (the check) is the question's state.
import { dayMonthQuestions, resolveAlternatives, swapDayMonth, type AmbiguousColumn, type VerifyResult } from '@formatai/engine';
import type { Expr, LearnAlternative, LearnResult, Validation } from '@formatai/shared';
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

// ---------- the day/month order (SPEC 21 v12 item 16): a question without a check, readings that only change the formats a date is read with ----------

describe('a day/month question', () => {
  const ambiguity = { kind: 'dayMonthOrder' as const, column: 'When', format: 'DD/MM/YYYY', other: 'MM/DD/YYYY' };
  const base = (route: 'inputFormats' | 'toDate'): LearnResult => ({
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: 'Id', type: 'text' },
        route === 'inputFormats' ? { id: 'when', header: 'When', type: 'date', inputFormats: ['DD/MM/YYYY', 'excelSerial'] } : { id: 'when', header: 'When', type: 'text' },
      ],
    },
    transform: {
      computed:
        route === 'inputFormats'
          ? []
          : [
              { id: 'month', type: 'integer', expr: { op: 'datePart', arg: { op: 'toDate', arg: { col: 'when' }, format: 'DD/MM/YYYY' }, part: 'month' } },
              // (a toDate of ANOTHER column, with the same format: not this question's)
              { id: 'other', type: 'text', expr: { op: 'toText', arg: { op: 'toDate', arg: { col: 'id' }, format: 'DD/MM/YYYY' } } },
            ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Id', from: 'id' },
        route === 'inputFormats' ? { header: 'When', from: 'when' } : { header: 'Month', from: 'month' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  });

  it('applying a reading changes the same places the engine\'s swapDayMonth does, and the other reading puts them back', () => {
    for (const route of ['inputFormats', 'toDate'] as const) {
      const rules = base(route);
      const [question] = dayMonthQuestions(rules, [ambiguity]);
      expect(question, route).toBeTruthy();
      const swapped = applyReading(rules, question!, 1, false)!;
      expect(swapped, route).toEqual(swapDayMonth(rules, ambiguity));
      expect(swapped, route).not.toEqual(rules);
      // (the toDate of ANOTHER column keeps its format)
      if (route === 'toDate') expect(JSON.stringify(swapped.transform.computed[1])).toContain('DD/MM/YYYY');
      expect(applyReading(swapped, question!, 0, false), route).toEqual(rules);
      // the reading the rules already have is no change at all
      expect(applyReading(rules, question!, 0, false), route).toEqual(rules);
      expect(applyReading(swapped, question!, 1, false), route).toEqual(swapped);
    }
  });

  it('is open while the rules read the format used, closed after the other order is applied, and open again when it is taken back', () => {
    const rules = base('inputFormats');
    const [question] = dayMonthQuestions(rules, [ambiguity]);
    expect(question!.check).toBeNull();
    expect(questionOpen(rules, question!)).toBe(true);
    const swapped = applyReading(rules, question!, 1, false)!;
    expect(questionOpen(swapped, question!)).toBe(false);
    expect(questionOpen(applyReading(swapped, question!, 0, false)!, question!)).toBe(true);
    // an AI answer's starting rules are left alone: the rules ARE the default
    expect(withOpenQuestion(rules, question!)).toBe(rules);
    expect(withOpenQuestion(rules, question!)!.validations).toEqual([]);
  });

  it('is not asked when the column no longer depends on the date column, or is gone', () => {
    const rules = base('toDate');
    const [question] = dayMonthQuestions(rules, [ambiguity]);
    const constant = { ...rules, transform: { ...rules.transform, computed: [{ id: 'month', type: 'integer' as const, expr: { const: 3 } }, rules.transform.computed[1]!] } };
    expect(questionOpen(constant, question!)).toBe(false);
    expect(questionOpen({ ...rules, output: { ...rules.output, columns: rules.output.columns.slice(0, 1) } }, question!)).toBe(false);
    expect(questionOpen({ ...rules, output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Month' ? { ...c, from: null } : c)) } }, question!)).toBe(false);
  });

  it('an answer never moves the column to another source: a column the user has since rebuilt keeps what it reads', () => {
    const rules = base('toDate');
    const [question] = dayMonthQuestions(rules, [ambiguity]);
    // the user made Month read another computed column (which also reads the date)
    const rebuilt: LearnResult = {
      ...rules,
      transform: {
        ...rules.transform,
        computed: [...rules.transform.computed, { id: 'month2', type: 'integer', expr: { op: 'datePart', arg: { op: 'toDate', arg: { col: 'when' }, format: 'DD/MM/YYYY' }, part: 'month' } }],
      },
      output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === 'Month' ? { ...c, from: 'month2' } : c)) },
    };
    const swapped = applyReading(rebuilt, question!, 1, false)!;
    expect(swapped.output.columns.find((c) => c.header === 'Month')!.from).toBe('month2');
    expect(swapped.transform.computed.map((c) => c.id)).toEqual(['month', 'other', 'month2']);
    expect(JSON.stringify(swapped.transform.computed.find((c) => c.id === 'month2'))).toContain('MM/DD/YYYY');
  });
});

describe('a question about a second rule the AI step gave (learn-v8, SPEC 21 v12 item 17)', () => {
  const cutoff = (n: number, op: 'gte' | 'gt', col = 'amount'): Expr => ({ op: 'if', cond: { op, args: [{ col }, { const: n }] }, then: { const: 'Urgent' }, else: { const: 'Normal' } }) as Expr;
  const answer: LearnResult = {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'order', header: 'Order', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
    transform: { computed: [{ id: 'priority', type: 'text', expr: cutoff(5000, 'gte') }], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Order', from: 'order' }, { header: 'Priority', from: 'priority' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
  const alternative: LearnAlternative = { outputColumn: 'Priority', from: 'priorityAlt', computed: [{ id: 'priorityAlt', type: 'text', expr: cutoff(4800, 'gt') }] };
  const fits: VerifyResult = { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] };
  /** What the engine returns when both rules fit every row: the question, and the rules with its check. */
  const resolved = resolveAlternatives({ rules: answer, masked: answer, verification: fits, alternatives: [alternative], verifyColumn: () => fits });
  const question = resolved.results[0]!.question!;

  it("the engine asks it with the answer's rule as the default and a sameAs check, already in the rules it returns", () => {
    expect(resolved.results[0]!.outcome).toBe('bothPass');
    expect(question.check).toEqual({ column: 'priority', rule: 'sameAs', expr: cutoff(4800, 'gt'), severity: 'flag' });
    // The Result screen's starting rules (`withOpenQuestion`) are the engine's: the marker is not put in twice.
    expect(withOpenQuestion(resolved.rules, question)).toEqual(resolved.rules);
    expect(questionOpen(resolved.rules, question)).toBe(true);
  });

  it('the web applies the formula reading: its computed column comes in, the old rule and the marker go - one undoable edit', () => {
    const store = new EditorStore(resolved.rules);
    const next = applyReading(store.getState().rules, question, 1, false)!;
    expect(next.output.columns[1]!.from).toBe('priorityAlt');
    expect(next.transform.computed).toEqual([{ id: 'priorityAlt', type: 'text', expr: cutoff(4800, 'gt') }]);
    expect(next.validations).toEqual([]);
    expect(questionOpen(next, question)).toBe(false);
    expect(store.apply({ type: 'replaceRules', rules: next })).toEqual({ ok: true, changed: true });
    store.undo();
    expect(questionOpen(store.getState().rules, question)).toBe(true);
  });

  it("answering with the answer's own rule keeps the rules as they are, without the marker", () => {
    expect(applyReading(resolved.rules, question, 0, false)).toEqual(answer);
  });

  it('applies to rules that name things another way (the user renamed the input id): matched by header', () => {
    const renamed: LearnResult = {
      ...resolved.rules,
      input: { ...answer.input, columns: [{ id: 'order', header: 'Order', type: 'text' }, { id: 'amt', header: 'Amount', type: 'decimal' }] },
      transform: { ...answer.transform, computed: [{ id: 'priority', type: 'text', expr: cutoff(5000, 'gte', 'amt') }] },
      validations: [{ ...question.check!, expr: cutoff(4800, 'gt', 'amt') } as Validation],
    };
    const next = applyReading(renamed, question, 1, false)!;
    expect(next.input.columns.map((c) => c.id)).toEqual(['order', 'amt']);
    expect(next.transform.computed.find((c) => c.id === next.output.columns[1]!.from)?.expr).toEqual(cutoff(4800, 'gt', 'amt'));
  });
});
