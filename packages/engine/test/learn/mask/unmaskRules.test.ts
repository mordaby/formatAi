import { describe, expect, it } from 'vitest';
import { createMasker } from '../../../src/learn/mask/masker';
import { unmaskRules } from '../../../src/learn/mask/unmaskRules';

function key(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

describe('unmaskRules', () => {
  it('restores every constant kind in a hand-built rules object, and leaves every structural field untouched', () => {
    const masker = createMasker(key('unmask-1'), { labelWords: ['דוח'] });

    const real = {
      valueMapFrom: 'חיים',
      valueMapTo: 'LIFE',
      filterValue: 'מבוטל',
      oneOfA: 'בדיקה',
      oneOfB: 'ניסיון',
      notOneOfA: 'בוטל',
      constLeaf: 'כהן',
      replaceFind: 'ישן',
      replaceWith: 'חדש',
      switchThen: 'טל',
      switchElse: 'אחר',
      lookupCell: 'קוד',
      titlePart: 'סוכן',
      summaryLabel: 'סה"כ לסוכן',
      grandTotalLabel: 'סה"כ',
      startsWithText: 'התחלה',
      endsWithText: 'סיום',
      containsText: 'מכיל',
      labelText: 'תוצר',
      splitSeparator: 'מפריד',
    };

    const fake = Object.fromEntries(
      Object.entries(real).map(([k, v]) => [k, masker.maskText(v)]),
    ) as typeof real;

    // A structural id that happens to collide (in the test data) with a fake
    // word's text — must NOT be turned back into anything, because "id"/"column"
    // are structural, never constants.
    const structuralIdThatLooksFake = fake.constLeaf;

    const rules = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: structuralIdThatLooksFake, header: 'שם לקוח', type: 'text' },
          { id: 'product', header: 'מוצר', type: 'text' },
          { id: 'status', header: 'סטטוס', type: 'text' },
        ],
        rowFilters: [
          { column: 'status', op: 'ne', value: fake.filterValue },
          { column: 'status', op: 'oneOf', value: [fake.oneOfA, fake.oneOfB] },
          { column: 'status', op: 'notOneOf', value: [fake.notOneOfA] },
        ],
      },
      transform: {
        computed: [
          {
            id: 'flag',
            type: 'text',
            expr: {
              op: 'if',
              cond: { op: 'eq', args: [{ col: 'product' }, { const: fake.constLeaf }] },
              then: {
                op: 'switch',
                cases: [{ when: { op: 'eq', args: [{ col: 'product' }, { const: 'x' }] }, then: { const: fake.switchThen } }],
                else: { const: fake.switchElse },
              },
              else: {
                op: 'replaceText',
                arg: { col: 'product' },
                find: fake.replaceFind,
                with: fake.replaceWith,
              },
            },
          },
          {
            id: 'startsCheck',
            type: 'boolean',
            expr: { op: 'startsWith', arg: { col: 'product' }, text: fake.startsWithText },
          },
          {
            id: 'endsCheck',
            type: 'boolean',
            expr: { op: 'endsWith', arg: { col: 'product' }, text: fake.endsWithText },
          },
          {
            id: 'containsCheck',
            type: 'boolean',
            expr: { op: 'contains', arg: { col: 'product' }, text: fake.containsText },
          },
          {
            id: 'lookupResult',
            type: 'text',
            expr: { op: 'lookup', table: 'codes', key: { col: 'product' }, return: 'rate', onMissing: 'flag' },
          },
          {
            id: 'splitPart',
            type: 'text',
            expr: { op: 'split', arg: { col: 'product' }, separator: fake.splitSeparator, index: 1 },
          },
        ],
        valueMaps: [{ column: 'product', map: { [fake.valueMapFrom]: fake.valueMapTo }, onMissing: 'flag' }],
        sort: [],
        group: {
          by: 'agent',
          showDetailRows: true,
          subtotal: { labelColumn: 'product', label: fake.summaryLabel, sum: ['premium'] },
        },
        tables: [{ name: 'codes', columns: ['code', 'rate'], rows: [[fake.lookupCell, 1]] }],
      },
      output: {
        sheetName: 'out',
        direction: 'rtl',
        language: 'he',
        titleRows: [
          { parts: [{ text: 'דוח ' }, { text: fake.titlePart }], bold: true },
          { text: fake.labelText },
        ],
        columns: [{ header: 'out1', from: 'product' }],
        grandTotal: { labelColumn: 'product', label: fake.grandTotalLabel, sum: ['premium'] },
      },
      validations: [{ column: 'product', rule: 'oneOf', values: [fake.oneOfA], severity: 'flag' }],
      unsupported: [],
      assumptions: [],
    };

    const restored = unmaskRules(rules, masker) as typeof rules;

    // Constants are restored to the real words.
    expect((restored.input.rowFilters[0] as { value: string }).value).toBe(real.filterValue);
    expect((restored.input.rowFilters[1] as { value: string[] }).value).toEqual([
      real.oneOfA,
      real.oneOfB,
    ]);
    expect((restored.input.rowFilters[2] as { value: string[] }).value).toEqual([real.notOneOfA]);

    const computed = restored.transform.computed as any[];
    expect(computed[0]!.expr.cond.args[1].const).toBe(real.constLeaf);
    expect(computed[0]!.expr.then.cases[0].then.const).toBe(real.switchThen);
    expect(computed[0]!.expr.then.else.const).toBe(real.switchElse);
    expect(computed[0]!.expr.else.find).toBe(real.replaceFind);
    expect(computed[0]!.expr.else.with).toBe(real.replaceWith);
    expect(computed[1]!.expr.text).toBe(real.startsWithText);
    expect(computed[2]!.expr.text).toBe(real.endsWithText);
    expect(computed[3]!.expr.text).toBe(real.containsText);
    expect(computed[5]!.expr.separator).toBe(real.splitSeparator);

    // value maps: BOTH keys and values are restored.
    const map = restored.transform.valueMaps[0]!.map as Record<string, string>;
    expect(map[real.valueMapFrom]).toBe(real.valueMapTo);
    expect(Object.keys(map)).toEqual([real.valueMapFrom]);

    // lookup table cell.
    expect((restored.transform.tables![0]!.rows[0]![0] as string)).toBe(real.lookupCell);

    // group/grandTotal labels.
    expect(restored.transform.group!.subtotal!.label).toBe(real.summaryLabel);
    expect(restored.output.grandTotal!.label).toBe(real.grandTotalLabel);

    // title texts/parts: the label word "דוח " passes through real, the fake
    // word next to it is restored, and mixing them in the same string works.
    const titleRow0 = restored.output.titleRows[0] as { parts: { text: string }[] };
    expect(titleRow0.parts[0]!.text).toBe('דוח ');
    expect(titleRow0.parts[1]!.text).toBe(real.titlePart);
    expect((restored.output.titleRows[1] as { text: string }).text).toBe(real.labelText);

    // validations oneOf values.
    expect((restored.validations[0] as { values: string[] }).values).toEqual([real.oneOfA]);

    // Structural fields are never touched, even when their text happens to
    // equal a fake word: the column id stays exactly as written.
    expect(restored.input.columns[0]!.id).toBe(structuralIdThatLooksFake);
    expect(restored.input.columns[0]!.header).toBe('שם לקוח');
    expect(restored.input.rowFilters[0]!.column).toBe('status');
    expect(restored.transform.valueMaps[0]!.onMissing).toBe('flag');
    expect(restored.transform.group!.by).toBe('agent');
    expect(restored.transform.tables![0]!.columns).toEqual(['code', 'rate']);
    expect(computed[4]!.expr.table).toBe('codes');
    expect(computed[4]!.expr.return).toBe('rate');
  });

  it('leaves numbers, booleans and null untouched', () => {
    const masker = createMasker(key('unmask-2'));
    const rules = { a: 5, b: true, c: null, d: [1, 2, 3] };
    expect(unmaskRules(rules, masker)).toEqual(rules);
  });

  it('does not mutate the input object', () => {
    const masker = createMasker(key('unmask-3'));
    const fake = masker.maskText('שלום');
    const rules = { const: fake };
    const restored = unmaskRules(rules, masker);
    expect(rules.const).toBe(fake); // original untouched
    expect((restored as typeof rules).const).toBe('שלום');
  });
});
