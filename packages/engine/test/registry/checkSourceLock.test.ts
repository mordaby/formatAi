// SPEC 8.15 "Sources": `sourceOf(rules)` extracts the source side of a conversion (input columns, reading options, input checks),
// and `checkSourceLock(rules, source)` holds every conversion of a source to it: every input column it declares exists in the
// source with the same header, aliases, type and padLeft (a SUBSET is allowed); its sheet pick, header row and stopAt equal the
// source's, and its input validations agree with the source's per column (block checks must equal, flag checks may differ).
// Synthetic, domain-neutral rules; the same shape of tests as `checkFormatLock.test.ts`.
import { describe, expect, it } from 'vitest';
import type { LearnResult, SourceStructure } from '@formatai/shared';
import { checkFormatLock } from '../../src/registry/checkFormatLock';
import { checkSourceLock, compareInputChecks } from '../../src/registry/checkSourceLock';
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
      expect(Object.keys(c).every((k) => ['header', 'aliases', 'type', 'required', 'padLeft', 'inputFormats', 'readAs'].includes(k))).toBe(true);
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

  it('DECISION (SPEC 8.4a): what a column reads another way (readAs) is part of the lock, compared as a dictionary', () => {
    const withMap = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer', readAs: { 'N/A': '', none: '0' } }] } });
    const sourceWith = sourceOf(withMap);
    expect(sourceWith.inputSignature.columns[0]).toEqual({ header: 'Qty', aliases: [], type: 'integer', required: false, readAs: { 'N/A': '', none: '0' } });
    expect(checkSourceLock(withMap, sourceWith)).toEqual([]);
    // key order changes nothing
    const reordered = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer', readAs: { none: '0', 'N/A': '' } }] } });
    expect(checkSourceLock(reordered, sourceWith)).toEqual([]);
    // a conversion that lacks it, has another text or another value reads another file
    const lacks = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer' }] } });
    expect(checkSourceLock(lacks, sourceWith).map((p) => p.path)).toEqual(['input.columns[0].readAs']);
    const other = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer', readAs: { 'N/A': '0', none: '0' } }] } });
    expect(checkSourceLock(other, sourceWith).map((p) => p.path)).toEqual(['input.columns[0].readAs']);
    // and the other way round: the source has none
    expect(checkSourceLock(withMap, source).map((p) => p.path)).toEqual(['input.columns[0].readAs']);
  });

  it('an empty readAs is no readAs', () => {
    const empty = makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer', readAs: {} }] } });
    expect(sourceOf(empty).inputSignature.columns[0]).toEqual({ header: 'Qty', aliases: [], type: 'integer', required: false });
    expect(checkSourceLock(empty, source)).toEqual([]);
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

  it('compares input validations as a set and by header, and leaves output validations to the format', () => {
    const check = { column: 'qty', rule: 'range', min: 0, severity: 'block' } as const;
    const withCheck = sourceOf(makeRules({ validations: [check] }));
    // a check that leaves rows out must agree: missing, extra and different
    expect(checkSourceLock(makeRules(), withCheck).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [check] }), source).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [{ ...check, min: 5 }] }), withCheck).map((p) => p.path)).toEqual(['validations', 'validations']);
    // the same checks in another order, another id for the column, and an explicit `on: 'input'`
    const two = sourceOf(makeRules({ validations: [{ ...check, severity: 'flag' }, { column: 'sku', rule: 'required', severity: 'block' }] }));
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

  // The bug: two formats learned from one file that read different columns carry different "required" checks (one per column read).
  it('DECISION: input checks are held per column, on the columns the conversion declares', () => {
    const required = (column: string) => ({ column, rule: 'required', severity: 'flag' }) as const;
    const wide = sourceOf(makeRules({ validations: [required('sku'), required('qty'), required('price')] }));
    // a conversion that reads fewer columns lacks the checks on the ones it doesn't read: no problem
    const subset = makeRules({
      input: { columns: [{ id: 'code', header: 'SKU', aliases: ['Item Code'], type: 'idLike', padLeft: 6 }, { id: 'p', header: 'Price', type: 'decimal' }] },
      validations: [required('code'), required('p')],
    });
    expect(checkSourceLock(subset, wide)).toEqual([]);
    // ...and so does one that has no checks at all
    expect(checkSourceLock(makeRules({ input: { columns: [{ id: 'q', header: 'Qty', type: 'integer' }] } }), wide)).toEqual([]);
    // the other way round: the source holds fewer checks than a conversion that reads another column too
    const narrow = sourceOf(makeRules({ validations: [required('sku')] }));
    expect(checkSourceLock(makeRules({ validations: [required('sku'), required('qty'), required('price')] }), narrow)).toEqual([]);
  });

  it('DECISION: a flag check only one side has, on a column both read, is no mismatch; a block check is', () => {
    const flag = { column: 'qty', rule: 'range', min: 0, severity: 'flag' } as const;
    const block = { ...flag, severity: 'block' } as const;
    // flag: only the conversion, only the source, or different bounds on each
    expect(checkSourceLock(makeRules({ validations: [flag] }), source)).toEqual([]);
    expect(checkSourceLock(makeRules(), sourceOf(makeRules({ validations: [flag] })))).toEqual([]);
    expect(checkSourceLock(makeRules({ validations: [{ ...flag, min: 5 }] }), sourceOf(makeRules({ validations: [flag] })))).toEqual([]);
    // block: it leaves rows out, so it would change the other conversion's output - whichever side has it
    const onlyConversion = checkSourceLock(makeRules({ validations: [block] }), source);
    expect(onlyConversion.map((p) => [p.kind, p.path])).toEqual([['sourceMismatch', 'validations']]);
    expect(onlyConversion[0]!.message).toContain('"Qty"');
    expect(checkSourceLock(makeRules(), sourceOf(makeRules({ validations: [block] }))).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [{ ...block, min: 5 }] }), sourceOf(makeRules({ validations: [block] }))).map((p) => p.path)).toEqual(['validations', 'validations']);
    // a flag check against a block one is a difference too: the block one is the mismatch
    expect(checkSourceLock(makeRules({ validations: [flag] }), sourceOf(makeRules({ validations: [block] }))).map((p) => p.path)).toEqual(['validations']);
    // a block check on a column the conversion doesn't declare is none of its business
    const other = makeRules({ input: { columns: [{ id: 's', header: 'SKU', aliases: ['Item Code'], type: 'idLike', padLeft: 6 }] } });
    expect(checkSourceLock(other, sourceOf(makeRules({ validations: [block] })))).toEqual([]);
  });

  it('a check on no column of the file (a computed one) is still compared as a whole', () => {
    const computed = { column: 'total', rule: 'range', min: 0, severity: 'flag' } as const;
    expect(checkSourceLock(makeRules({ validations: [computed] }), source).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules(), sourceOf(makeRules({ validations: [computed] }))).map((p) => p.path)).toEqual(['validations']);
    expect(checkSourceLock(makeRules({ validations: [computed] }), sourceOf(makeRules({ validations: [computed] })))).toEqual([]);
    // a check on a column of either side is tied to it: a column the source lacks is reported once, not again as a loose check
    const noQty: SourceStructure = { ...source, inputSignature: { columns: source.inputSignature.columns.filter((c) => c.header !== 'Qty') }, inputValidations: [{ column: 'Qty', rule: 'required', severity: 'flag' }] };
    expect(checkSourceLock(makeRules({ validations: [{ column: 'qty', rule: 'required', severity: 'flag' }] }), noQty).map((p) => p.message)).toEqual(['column "Qty" is not in the source']);
  });

  it('compareInputChecks says what a source gains: flag checks on shared columns it lacks, and every check on a column only the conversion reads', () => {
    const flag = { column: 'Qty', rule: 'range', min: 0, severity: 'flag' } as const;
    const onNew = { column: 'Weight', rule: 'required', severity: 'block' } as const;
    const own: SourceStructure = {
      inputSignature: { columns: [...source.inputSignature.columns, { header: 'Weight', aliases: [], type: 'decimal', required: false }] },
      inputReading: source.inputReading,
      inputValidations: [flag, onNew, { column: 'SKU', rule: 'required', severity: 'block' }],
    };
    const there: SourceStructure = { ...source, inputValidations: [{ column: 'SKU', rule: 'required', severity: 'block' }] };
    expect(compareInputChecks(own, there)).toEqual({ problems: [], additions: [flag, onNew] });
    // a block check on a shared column is a problem, not an addition
    const block = { ...flag, severity: 'block' } as const;
    const r = compareInputChecks({ ...own, inputValidations: [block] }, there);
    expect(r.additions).toEqual([]);
    expect(r.problems.map((p) => p.path)).toEqual(['validations', 'validations']); // the conversion's block check, and the source's SKU one
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
