// SPEC 8.15 "Sources": `sourceOf(rules)` extracts the source side of a conversion (input columns, reading options, input checks),
// and `checkSourceLock(rules, source)` holds every conversion of a source to it: every input column it declares exists in the
// source with the same header, aliases, type and padLeft (a SUBSET is allowed); its sheet pick, header row, stopAt and input
// validations equal the source's. Synthetic, domain-neutral rules; the same shape of tests as `checkFormatLock.test.ts`.
import { describe, expect, it } from 'vitest';
import type { LearnResult, SourceStructure } from '@formatai/shared';
import { checkFormatLock } from '../../src/registry/checkFormatLock';
import { checkSourceLock } from '../../src/registry/checkSourceLock';
import { findSourceColumn, sourceHeaderKey, sourceOf } from '../../src/registry/sourceOf';

function makeRules(over: { input?: Partial<LearnResult['input']>; validations?: LearnResult['validations'] } = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'sku', header: 'SKU', aliases: ['Item Code'], type: 'idLike', required: true, padLeft: 6 },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'price', header: 'Price', type: 'decimal', required: true },
        { id: 'day', header: 'Day', type: 'date', inputFormats: ['dd/mm/yyyy'] },
      ],
      ...over.input,
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Code', from: 'sku' },
        { header: 'Price', from: 'price' },
      ],
    },
    validations: over.validations ?? [],
    unsupported: [],
    assumptions: [],
  };
}

const source: SourceStructure = sourceOf(makeRules());

describe('sourceOf', () => {
  it('reads the declared input columns: header, aliases, type, required, padLeft and inputFormats', () => {
    expect(source.inputSignature.columns).toEqual([
      { header: 'SKU', aliases: ['Item Code'], type: 'idLike', required: true, padLeft: 6 },
      { header: 'Qty', aliases: [], type: 'integer', required: false },
      { header: 'Price', aliases: [], type: 'decimal', required: true },
      { header: 'Day', aliases: [], type: 'date', required: false, inputFormats: ['dd/mm/yyyy'] },
    ]);
  });

  it('reads the sheet pick, header row and stopAt', () => {
    expect(source.inputReading).toEqual({ sheet: { pick: 'first' }, headerRow: 'auto' });
    const custom = sourceOf(
      makeRules({ input: { sheet: { pick: 'name', name: 'Data' }, headerRow: 3, stopAt: { when: 'firstCellMatches', values: ['Total'] } } }),
    );
    expect(custom.inputReading).toEqual({ sheet: { pick: 'name', name: 'Data' }, headerRow: 3, stopAt: { when: 'firstCellMatches', values: ['Total'] } });
  });

  it('keeps only the input validations, with the column named by its header (ids differ between conversions)', () => {
    const s = sourceOf(
      makeRules({
        validations: [
          { column: 'qty', rule: 'range', min: 0, severity: 'flag' },
          { on: 'input', column: 'sku', rule: 'required', severity: 'block' },
          { on: 'output', column: 'Code', rule: 'unique', severity: 'flag' },
        ],
      }),
    );
    expect(s.inputValidations).toEqual([
      { column: 'Qty', rule: 'range', min: 0, severity: 'flag' },
      { column: 'SKU', rule: 'required', severity: 'block' },
    ]);
  });

  it('is pure: never mutates the rules, and its result shares nothing with them', () => {
    const rules = makeRules();
    const before = JSON.stringify(rules);
    const s = sourceOf(rules);
    s.inputSignature.columns[0]!.aliases.push('X');
    s.inputReading.sheet = { pick: 'index', index: 2 };
    expect(JSON.stringify(rules)).toBe(before);
  });

  it('holds structure only: no field of the result can carry a value read from the data', () => {
    const s = sourceOf(makeRules({ validations: [{ column: 'qty', rule: 'range', min: 1, max: 9, severity: 'flag' }] }));
    expect(Object.keys(s).sort()).toEqual(['inputReading', 'inputSignature', 'inputValidations']);
    for (const c of s.inputSignature.columns) {
      expect(Object.keys(c).every((k) => ['header', 'aliases', 'type', 'required', 'padLeft', 'inputFormats'].includes(k))).toBe(true);
    }
  });
});

describe('header lookup (the way the engine finds a column)', () => {
  const cols = source.inputSignature.columns;
  it('exact header, then exact alias, then normalized header or alias', () => {
    expect(findSourceColumn(cols, 'Qty')).toBe(1);
    expect(findSourceColumn(cols, 'Item Code')).toBe(0);
    expect(findSourceColumn(cols, ' qty ')).toBe(1); // surrounding spaces and case are normalized away
    expect(findSourceColumn(cols, 'QTY')).toBe(1);
    expect(findSourceColumn(cols, 'item code')).toBe(0);
    expect(findSourceColumn(cols, 'Nothing')).toBe(-1);
    expect(findSourceColumn(cols, '')).toBe(-1);
  });
  it('normalizes headers like matching does (Hebrew quotes, case)', () => {
    expect(sourceHeaderKey('מק״ט')).toBe(sourceHeaderKey('מק"ט'));
    expect(sourceHeaderKey('Item')).toBe(sourceHeaderKey('ITEM'));
  });
});

describe('checkSourceLock', () => {
  it('passes for the rules the source was made from', () => {
    expect(checkSourceLock(makeRules(), source)).toEqual([]);
  });

  it('allows a SUBSET of the source’s columns (a master file feeds formats that read different columns)', () => {
    const subset = makeRules({
      input: {
        columns: [
          { id: 'code', header: 'SKU', aliases: ['Item Code'], type: 'idLike', padLeft: 6 },
          { id: 'p', header: 'Price', type: 'decimal' },
        ],
      },
    });
    expect(checkSourceLock(subset, source)).toEqual([]);
  });

  it('passes with entirely different ids, different `required` flags and aliases in another order', () => {
    const other = makeRules({
      input: {
        columns: [
          { id: 'a', header: 'SKU', aliases: ['Item Code'], type: 'idLike', required: false, padLeft: 6 },
          { id: 'b', header: 'Qty', type: 'integer', required: true },
        ],
      },
    });
    expect(checkSourceLock(other, source)).toEqual([]);
    const twoAliases = sourceOf(makeRules({ input: { columns: [{ id: 'x', header: 'SKU', aliases: ['A', 'B'], type: 'idLike' }] } }));
    const reordered = makeRules({ input: { columns: [{ id: 'y', header: 'SKU', aliases: ['B', 'A'], type: 'idLike' }] } });
    expect(checkSourceLock(reordered, twoAliases)).toEqual([]);
  });

  it('reports a column the source does not have', () => {
    const rules = makeRules({ input: { columns: [{ id: 'z', header: 'Weight', type: 'decimal' }] } });
    expect(checkSourceLock(rules, source)).toEqual([
      { kind: 'sourceMismatch', path: 'input.columns[0]', message: 'column "Weight" is not in the source' },
    ]);
  });

  it('reports a header that differs (it is a different column to the source)', () => {
    const rules = makeRules({ input: { columns: [{ id: 'q', header: 'Quantity', type: 'integer' }] } });
    expect(checkSourceLock(rules, source).map((p) => p.path)).toEqual(['input.columns[0]']);
  });

  it('reports different aliases', () => {
    const rules = makeRules({ input: { columns: [{ id: 'sku', header: 'SKU', aliases: ['Other'], type: 'idLike', padLeft: 6 }] } });
    const problems = checkSourceLock(rules, source);
    expect(problems.map((p) => p.path)).toEqual(['input.columns[0].aliases']);
    expect(problems[0]!.kind).toBe('sourceMismatch');
    // ...unless the check is made before a save, where the server merges aliases instead of refusing:
    expect(checkSourceLock(rules, source, { ignoreAliases: true })).toEqual([]);
  });

  it('reports a different type', () => {
    const rules = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'decimal' }] } });
    expect(checkSourceLock(rules, source).map((p) => p.path)).toEqual(['input.columns[0].type']);
  });

  it('reports a different padLeft (present, absent or another number)', () => {
    const absent = makeRules({ input: { columns: [{ id: 's', header: 'SKU', aliases: ['Item Code'], type: 'idLike' }] } });
    expect(checkSourceLock(absent, source).map((p) => p.path)).toEqual(['input.columns[0].padLeft']);
    const other = makeRules({ input: { columns: [{ id: 's', header: 'SKU', aliases: ['Item Code'], type: 'idLike', padLeft: 8 }] } });
    expect(checkSourceLock(other, source).map((p) => p.path)).toEqual(['input.columns[0].padLeft']);
    const added = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer', padLeft: 3 }] } });
    expect(checkSourceLock(added, source).map((p) => p.path)).toEqual(['input.columns[0].padLeft']);
  });

  it('DECISION: date formats (inputFormats) are part of the lock - it is how the column is read', () => {
    const rules = makeRules({ input: { columns: [{ id: 'd', header: 'Day', type: 'date', inputFormats: ['yyyy-mm-dd'] }] } });
    expect(checkSourceLock(rules, source).map((p) => p.path)).toEqual(['input.columns[0].inputFormats']);
    const none = makeRules({ input: { columns: [{ id: 'd', header: 'Day', type: 'date' }] } });
    expect(checkSourceLock(none, source).map((p) => p.path)).toEqual(['input.columns[0].inputFormats']);
  });

  it('reports every field that differs, each with its own path', () => {
    const rules = makeRules({ input: { columns: [{ id: 's', header: 'SKU', aliases: [], type: 'text' }] } });
    expect(checkSourceLock(rules, source).map((p) => p.path)).toEqual([
      'input.columns[0].aliases',
      'input.columns[0].type',
      'input.columns[0].padLeft',
    ]);
  });

  it('reports a different sheet pick, header row and stopAt', () => {
    expect(checkSourceLock(makeRules({ input: { sheet: { pick: 'name', name: 'Data' } } }), source).map((p) => p.path)).toEqual(['input.sheet']);
    expect(checkSourceLock(makeRules({ input: { sheet: { pick: 'index', index: 1 } } }), source).map((p) => p.path)).toEqual(['input.sheet']);
    expect(checkSourceLock(makeRules({ input: { headerRow: 2 } }), source).map((p) => p.path)).toEqual(['input.headerRow']);
    expect(
      checkSourceLock(makeRules({ input: { stopAt: { when: 'firstCellMatches', values: ['Total'] } } }), source).map((p) => p.path),
    ).toEqual(['input.stopAt']);
    // and a stopAt the source has but the conversion lacks
    const withStop = sourceOf(makeRules({ input: { stopAt: { when: 'firstCellMatches', values: ['Total'] } } }));
    expect(checkSourceLock(makeRules(), withStop).map((p) => p.path)).toEqual(['input.stopAt']);
  });

  it('reports different input validations, compares them as a set and by header, and leaves output validations to the format', () => {
    const check = { column: 'qty', rule: 'range', min: 0, severity: 'flag' } as const;
    const withCheck = sourceOf(makeRules({ validations: [check] }));
    // missing, extra and different
    expect(checkSourceLock(makeRules(), withCheck).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [check] }), source).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [{ ...check, min: 5 }] }), withCheck).map((p) => p.path)).toEqual(['validations']);
    // the same checks in another order, another id for the column, and an explicit `on: 'input'`
    const two = sourceOf(makeRules({ validations: [check, { column: 'sku', rule: 'required', severity: 'block' }] }));
    const same = makeRules({
      input: { columns: [{ id: 'quantity', header: 'Qty', type: 'integer' }, { id: 'code', header: 'SKU', aliases: ['Item Code'], type: 'idLike', padLeft: 6 }] },
      validations: [
        { on: 'input', column: 'code', rule: 'required', severity: 'block' },
        { column: 'quantity', rule: 'range', min: 0, severity: 'flag' },
      ],
    });
    expect(checkSourceLock(same, two)).toEqual([]);
    // an output check is the format's business
    const outputOnly = makeRules({ validations: [{ on: 'output', column: 'Code', rule: 'unique', severity: 'flag' }] });
    expect(checkSourceLock(outputOnly, source)).toEqual([]);
    expect(checkFormatLock(outputOnly, { output: sourceFormat(), layout: { sort: [] }, outputValidations: [] }).map((p) => p.path)).toContain('validations');
  });

  it('never mutates its arguments', () => {
    const rules = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'decimal' }] } });
    const beforeRules = JSON.stringify(rules);
    const beforeSource = JSON.stringify(source);
    checkSourceLock(rules, source);
    expect(JSON.stringify(rules)).toBe(beforeRules);
    expect(JSON.stringify(source)).toBe(beforeSource);
  });
});

function sourceFormat() {
  return {
    file: { type: 'xlsx' as const },
    sheetName: 'Out',
    direction: 'ltr' as const,
    language: 'en' as const,
    titleRows: [],
    columns: [{ header: 'Code' }, { header: 'Price' }],
    summaryRows: [],
  };
}
