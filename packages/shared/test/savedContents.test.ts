// What a saved format keeps (docs/proposals/saved-format-contents.md; `rules/savedContents.ts`): every value of the rules with where it sits,
// the identifier-shaped ones as the Save popup's lines (column and kind, never the value), "Save without them", what the server already holds,
// and the size caps (section 7: 500 value-map entries, 300 characters per value (owner, 2026-10-06; the proposal said 200), 64 KB per version).
import { describe, expect, it } from 'vitest';
import { limits } from '../src/config/limits';
import {
  contentLimitMessage,
  contentLimitProblems,
  identifierFindings,
  identifiersToConfirm,
  rulesBytes,
  SAVED_WITHOUT_REASON,
  savedValues,
  utf8Length,
  withoutIdentifiers,
} from '../src/rules/savedContents';
import { LearnResultSchema, type Expr, type LearnResult } from '../src/rules/schema';

const col = (id: string): Expr => ({ col: id });
const str = (v: string): Expr => ({ const: v });
const iff = (cond: Expr, then: Expr, otherwise: Expr): Expr => ({ op: 'if', cond, then, else: otherwise });
const gt = (a: Expr, b: Expr): Expr => ({ op: 'gt', args: [a, b] });

const ID = '123456782';

/** Orders: a target customer by amount (a label that is an ID), an expense account by type (ledger labels), a class through a helper. */
function rules(target: Expr = iff(gt(col('amount'), { const: 1000 }), str(ID), str('')), extra: Partial<LearnResult> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text' },
        { id: 'type', header: 'Expense type', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: {
      computed: [
        { id: 'target', type: 'text', expr: target },
        { id: 'account', type: 'text', expr: { op: 'lookup', table: 'ledger', key: col('type'), return: 'account', onMissing: 'flag' } },
        { id: 'big', type: 'boolean', expr: gt(col('amount'), { const: 5000 }) },
        { id: 'size', type: 'text', expr: iff(col('big'), str('Big'), str('Small')) },
      ],
      valueMaps: [{ column: 'type', map: { Travel: 'נסיעות', Meals: 'כיבוד' }, onMissing: 'keep' }],
      sort: [],
      tables: [{ name: 'ledger', columns: ['type', 'account'], rows: [['Travel', '61000100'], ['Meals', '61000200'], ['Rent', '62000100']] }],
    },
    output: {
      sheetName: 'S',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: 'Orders report' }],
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Type', from: 'type' },
        { header: 'Target customer', from: 'target' },
        { header: 'Ledger account', from: 'account' },
        { header: 'Size', from: 'size' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
    ...extra,
  };
}

describe('savedValues: every value the rules keep, and where', () => {
  it('a label in an expression, a table cell, a value-map entry, a title - each with the columns it reaches (through a helper too)', () => {
    const values = savedValues(rules());
    const at = (v: string | number) => values.filter((x) => x.value === v).map((x) => x.place);
    expect(at(ID)).toEqual([{ kind: 'output', headers: ['Target customer'] }]);
    expect(at('61000100')).toEqual([{ kind: 'output', headers: ['Ledger account'] }]);
    // (a table key, and a value map's key on the column Type shows: the map changes what the output shows, after the computed columns)
    expect(at('Travel')).toEqual([{ kind: 'output', headers: ['Ledger account'] }, { kind: 'output', headers: ['Type'] }]);
    expect(at('Big')).toEqual([{ kind: 'output', headers: ['Size'] }]);
    // The helper `big` is reached by Size only.
    expect(at(5000)).toEqual([{ kind: 'output', headers: ['Size'] }]);
    expect(at('Orders report')).toEqual([{ kind: 'layout' }]);
    // Not values: ids, headers, table and column names.
    expect(at('ledger')).toEqual([]);
    expect(at('Target customer')).toEqual([]);
  });

  it('a fix, a filter and a check say the column they are on', () => {
    const base = rules();
    const r: LearnResult = {
      ...base,
      input: {
        ...base.input,
        columns: base.input.columns.map((c) => (c.id === 'order' ? { ...c, readAs: { 'N/A': '' } } : c)),
        rowFilters: [{ column: 'type', op: 'ne', value: 'Internal' }],
      },
      validations: [{ column: 'type', rule: 'oneOf', values: ['Travel', 'Meals'], severity: 'flag' }],
    };
    const places = savedValues(r).filter((v) => v.place.kind === 'readAs' || v.place.kind === 'filter' || v.place.kind === 'check');
    expect(places.map((v) => [v.value, v.place])).toEqual([
      ['N/A', { kind: 'readAs', column: 'order', header: 'Order', text: 'N/A' }],
      ['', { kind: 'readAs', column: 'order', header: 'Order', text: 'N/A' }],
      ['Internal', { kind: 'filter', index: 0, header: 'Expense type' }],
      ['Travel', { kind: 'check', index: 0, header: 'Expense type' }],
      ['Meals', { kind: 'check', index: 0, header: 'Expense type' }],
    ]);
  });
});

describe('identifierFindings: the Save popup\'s lines', () => {
  it('a logic rule whose label is an ID: one line, the column and the kind, no value', () => {
    expect(identifierFindings(rules())).toEqual([{ kind: 'identifier', header: 'Target customer', idKind: 'israeliId', out: 2 }]);
    expect(JSON.stringify(identifierFindings(rules()))).not.toContain(ID);
  });

  it('NOT ledger-account labels (8-digit codes), a 9-digit code that fails the check digit, or amounts', () => {
    expect(identifierFindings(rules(iff(gt(col('amount'), { const: 1000 }), str('123456789'), str(''))))).toEqual([]);
  });

  it('an ID stored as a number in a condition, a phone in a value map, an email in a fix, a card in a check', () => {
    const base = rules(iff({ op: 'eq', args: [col('order'), { const: 123456782 }] }, str('VIP'), str('')));
    const r: LearnResult = {
      ...base,
      input: { ...base.input, columns: base.input.columns.map((c) => (c.id === 'type' ? { ...c, readAs: { 'see mail': 'dana@example.com' } } : c)) },
      transform: { ...base.transform, valueMaps: [{ column: 'type', map: { Travel: '050-1234567' }, onMissing: 'keep' }] },
      validations: [{ column: 'order', rule: 'oneOf', values: ['4111 1111 1111 1111'], severity: 'flag' }],
    };
    expect(identifierFindings(r)).toEqual([
      { kind: 'identifier', header: 'Type', idKind: 'phone', out: 1 },
      // (The value map changes Type as the output shows it; the lookup reads Type before the maps run, so Ledger account keeps no phone.)
      { kind: 'identifier', header: 'Target customer', idKind: 'israeliId', out: 2 },
      { kind: 'identifier', header: 'Expense type', idKind: 'email' },
      { kind: 'identifier', header: 'Order', idKind: 'card' },
    ]);
  });

  it('identifiersToConfirm: a value the server already holds in that line is not asked again; a new one is', () => {
    const now = rules();
    expect(identifiersToConfirm(now)).toEqual(identifierFindings(now));
    expect(identifiersToConfirm(now, now)).toEqual([]);
    const other = rules(iff(gt(col('amount'), { const: 1000 }), str('039337423'), str('')));
    expect(identifiersToConfirm(other, now)).toEqual([{ kind: 'identifier', header: 'Target customer', idKind: 'israeliId', out: 2 }]);
  });
});

describe('withoutIdentifiers: "Save without them"', () => {
  it('the column is taken out (needs your input, savedWithout) and the value is gone; the rest stays', () => {
    const out = withoutIdentifiers(rules(), identifierFindings(rules()));
    expect(out.output.columns[2]).toEqual({ header: 'Target customer', from: null });
    expect(out.unsupported).toEqual([{ outputColumn: 'Target customer', reasonCode: SAVED_WITHOUT_REASON }]);
    expect(SAVED_WITHOUT_REASON).toBe('savedWithout');
    expect(JSON.stringify(out)).not.toContain(ID);
    expect(out.transform.computed.map((c) => c.id)).toEqual(['account', 'big', 'size']);
    expect(identifierFindings(out)).toEqual([]);
    expect(LearnResultSchema.safeParse(out).success).toBe(true);
  });

  it('a fix, a filter or a check holding one is removed; a line not asked about stays', () => {
    const base = rules();
    const r: LearnResult = {
      ...base,
      input: {
        ...base.input,
        columns: base.input.columns.map((c) => (c.id === 'type' ? { ...c, readAs: { x: 'dana@example.com', y: 'Meals' } } : c)),
        rowFilters: [{ column: 'order', op: 'ne', value: '039337423' }],
      },
      validations: [{ column: 'order', rule: 'oneOf', values: ['4111111111111111'], severity: 'flag' }],
    };
    const lines = identifierFindings(r).filter((l) => l.header !== 'Target customer');
    const out = withoutIdentifiers(r, lines);
    expect(out.input.columns.find((c) => c.id === 'type')?.readAs).toEqual({ y: 'Meals' });
    expect(out.input.rowFilters).toBeUndefined();
    expect(out.validations).toEqual([]);
    expect(identifierFindings(out)).toEqual([{ kind: 'identifier', header: 'Target customer', idKind: 'israeliId', out: 2 }]);
  });
});

describe('the size caps (section 7)', () => {
  it('the config values the owner approved (and 500 characters for a title)', () => {
    expect(limits.rules).toMatchObject({ maxValueMapEntries: 500, maxValueChars: 300, maxTitleChars: 500, maxRulesBytes: 65_536 });
  });

  it('a title row or a summary row\'s label: 500 characters is fine, 501 is over; a "stop at" text stays at 300', () => {
    const base = rules();
    const titled = (n: number): LearnResult => ({ ...base, output: { ...base.output, titleRows: [{ text: 'x'.repeat(n) }, { parts: [{ text: 'y'.repeat(10) }] }] } });
    expect(contentLimitProblems(titled(500))).toEqual([]);
    expect(contentLimitProblems(titled(501))).toEqual([{ code: 'titleChars', path: 'output.titleRows[0]', chars: 501, max: 500 }]);
    const summed = (n: number): LearnResult => ({ ...base, output: { ...base.output, summaryRows: [{ label: 'z'.repeat(n), cells: {} }] } });
    expect(contentLimitProblems(summed(500))).toEqual([]);
    expect(contentLimitProblems(summed(501)).map((p) => p.code)).toEqual(['titleChars']);
    const grouped: LearnResult = { ...base, transform: { ...base.transform, group: { by: 'type', showDetailRows: true, summaryRows: [{ label: 'g'.repeat(501), cells: {} }] } } };
    expect(contentLimitProblems(grouped).map((p) => p.code === 'titleChars' && p.path)).toEqual(['transform.group.summaryRows[0]']);
    const stop = (n: number): LearnResult => ({ ...base, input: { ...base.input, stopAt: { when: 'firstCellMatches', values: ['s'.repeat(n)] } } });
    expect(contentLimitProblems(stop(300))).toEqual([]);
    expect(contentLimitProblems(stop(301)).map((p) => p.code)).toEqual(['valueChars']);
    expect(contentLimitMessage(contentLimitProblems(titled(501))[0]!)).toBe("a title of 501 characters, exceeding the maximum of 500 characters for a title or a summary row's label");
  });

  it('a value map of 500 entries is fine, 501 is over', () => {
    const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]));
    const base = rules();
    const withMap = (n: number): LearnResult => ({ ...base, transform: { ...base.transform, valueMaps: [{ column: 'type', map: map(n), onMissing: 'flag' }] } });
    expect(contentLimitProblems(withMap(500))).toEqual([]);
    expect(contentLimitProblems(withMap(501))).toEqual([{ code: 'valueMapEntries', path: 'transform.valueMaps[0]', column: 'type', entries: 501, max: 500 }]);
  });

  it('a value of 300 characters is fine, 301 is over - a label, a table cell, a condition\'s constant, a fix', () => {
    const at = (n: number) => 'x'.repeat(n);
    expect(contentLimitProblems(rules(iff(gt(col('amount'), { const: 1 }), str(at(300)), str(''))))).toEqual([]);
    expect(contentLimitProblems(rules(iff(gt(col('amount'), { const: 1 }), str(at(301)), str(''))))).toEqual([{ code: 'valueChars', path: 'transform.computed[0].expr', chars: 301, max: 300 }]);
    const base = rules();
    const cell: LearnResult = { ...base, transform: { ...base.transform, tables: [{ name: 'ledger', columns: ['type', 'account'], rows: [['Travel', at(350)]] }] } };
    expect(contentLimitProblems(cell).map((p) => p.code === 'valueChars' && [p.path, p.chars])).toEqual([['transform.tables[0]', 350]]);
    const condition = rules(iff({ op: 'contains', arg: col('order'), text: at(301) }, str('A'), str('B')));
    expect(contentLimitProblems(condition).map((p) => p.code)).toEqual(['valueChars']);
    const fix: LearnResult = { ...base, input: { ...base.input, columns: base.input.columns.map((c) => (c.id === 'order' ? { ...c, readAs: { 'N/A': at(301) } } : c)) } };
    expect(contentLimitProblems(fix).map((p) => p.code === 'valueChars' && p.path)).toEqual(['input.columns[0].readAs']);
  });

  it('one version over 64 KB is over (counted in UTF-8 bytes: Hebrew is two each)', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('קטנה')).toBe(8);
    const base = rules();
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [`t${i}`, 'נ'.repeat(60)]);
    const big: LearnResult = { ...base, transform: { ...base.transform, tables: [{ name: 'ledger', columns: ['type', 'account'], rows: rows(500) }] } };
    expect(rulesBytes(big)).toBeGreaterThan(limits.rules.maxRulesBytes);
    const [p] = contentLimitProblems(big);
    expect(p).toMatchObject({ code: 'rulesBytes', max: 65_536 });
    const small: LearnResult = { ...base, transform: { ...base.transform, tables: [{ name: 'ledger', columns: ['type', 'account'], rows: rows(100) }] } };
    expect(contentLimitProblems(small)).toEqual([]);
  });

  it('the message names counts, never a value', () => {
    const p = contentLimitProblems(rules(iff(gt(col('amount'), { const: 1 }), str(`${ID}${'x'.repeat(300)}`), str(''))))[0]!;
    expect(contentLimitMessage(p)).toBe('a value of 309 characters, exceeding the maximum of 300 characters for one value');
    expect(contentLimitMessage(p)).not.toContain(ID);
  });
});
