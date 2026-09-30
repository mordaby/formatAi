// The fixed lock of completion mode (LEARN_PROMPT "Completing a partial rules file"): an answer must contain every element of the rules the
// user already had, unchanged; only what is listed (output columns, layout parts) may be produced. One passing case, then each way to break it.
import type { Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { checkFixedLock, type FixedLockOptions } from '../../src/registry';

/** What the user has: two built columns, a filter, a check, and two columns with no rule (one external data). */
function fixedRules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: 'ID', type: 'idLike', required: true },
        { id: 'amount', header: 'Amount', type: 'decimal' },
        { id: 'status', header: 'Status', type: 'text' },
      ],
      rowFilters: [{ column: 'status', op: 'ne', value: 'void' }],
    },
    transform: {
      computed: [{ id: 'gross', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 1.17 }] } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [{ text: 'Report' }],
      columns: [
        { header: 'ID', from: 'id' },
        { header: 'Gross', from: 'gross', format: '#,##0.00', width: 12 },
        { header: 'Label', from: null },
        { header: 'Note', from: null },
      ],
      headerStyle: { bold: true },
    },
    validations: [{ column: 'amount', rule: 'range', min: 0, severity: 'flag' }],
    unsupported: [{ outputColumn: 'Note', reasonCode: 'externalData' }],
    assumptions: [],
  };
}

const LABEL_EXPR: Expr = { op: 'if', cond: { op: 'gt', args: [{ col: 'amount' }, { const: 100 }] }, then: { const: 'Big' }, else: { const: 'Small' } };

/** The answer that does what was asked: a computed column for `Label` (listed), everything else untouched. */
function goodAnswer(): LearnResult {
  const f = fixedRules();
  return {
    ...f,
    transform: { ...f.transform, computed: [...f.transform.computed, { id: 'label', type: 'text', expr: LABEL_EXPR }] },
    output: { ...f.output, columns: f.output.columns.map((c) => (c.header === 'Label' ? { header: 'Label', from: 'label' } : c)) },
  };
}

const LISTED: FixedLockOptions = { columns: [2], parts: [] };

function problemsOf(answer: LearnResult, opts: FixedLockOptions = LISTED, fixed: LearnResult = fixedRules()) {
  return checkFixedLock(answer, fixed, opts);
}
const paths = (answer: LearnResult, opts?: FixedLockOptions, fixed?: LearnResult): string[] => problemsOf(answer, opts, fixed).map((p) => p.path);

describe('checkFixedLock: what passes', () => {
  it('an answer that only produces the listed column passes', () => {
    expect(problemsOf(goodAnswer())).toEqual([]);
  });

  it('new ids (input columns, computed columns, functions, tables) are welcome', () => {
    const a = goodAnswer();
    a.input.columns = [...a.input.columns, { id: 'region', header: 'Region', type: 'text' }];
    a.transform.tables = [{ name: 'rates', columns: ['code', 'rate'], rows: [['a', 1]] }];
    expect(problemsOf(a)).toEqual([]);
  });

  it('a formula written differently but meaning the same is the same rule (canonicalized)', () => {
    const fixed = fixedRules();
    fixed.transform.computed = [{ id: 'gross', type: 'decimal', expr: { op: 'add', args: [{ op: 'add', args: [{ col: 'amount' }, { const: 1 }] }, { const: 2 }] } }];
    const a = goodAnswer();
    a.transform.computed = [{ id: 'gross', type: 'decimal', expr: { op: 'add', args: [{ col: 'amount' }, { const: 1 }, { const: 2 }] } }, a.transform.computed[1]!];
    expect(problemsOf(a, LISTED, fixed)).toEqual([]);
  });

  it('a stored rules file (with name and meta) compares like a learn answer', () => {
    const fixed = { ...fixedRules(), name: 'My format', meta: { source: 'examplePair', status: 'userConfirmed', learnPath: 'llm', schemaVersion: 1 } } as unknown as LearnResult;
    expect(problemsOf(goodAnswer(), LISTED, fixed)).toEqual([]);
  });

  it('a listed column the AI step could not produce is fine when it is reported as unsupported', () => {
    const a = fixedRules();
    a.unsupported = [...a.unsupported, { outputColumn: 'Label', reasonCode: 'ambiguous' }];
    expect(problemsOf(a)).toEqual([]);
  });

  it('a listed part may be produced: a sort, a group with summary rows', () => {
    const a = goodAnswer();
    a.transform.sort = [{ column: 'id', dir: 'asc' }];
    a.transform.group = { by: 'status', showDetailRows: true, blankRowsAfter: 1, summaryRows: [{ label: 'Total', cells: { Gross: 'sum' } }] };
    a.output.summaryRows = [{ label: 'Grand total', cells: { Gross: 'sum' } }];
    expect(problemsOf(a, { columns: [2], parts: ['sort', 'group', 'summaryRows', 'blankRows'] })).toEqual([]);
  });
});

describe('checkFixedLock: a fixed element changed or went missing (fixedMismatch)', () => {
  it('every problem is a fixedMismatch with a path and a message', () => {
    const a = goodAnswer();
    a.transform.computed = [a.transform.computed[1]!];
    const problems = problemsOf(a);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) {
      expect(p.kind).toBe('fixedMismatch');
      expect(p.path).not.toBe('');
      expect(p.message).not.toBe('');
    }
  });

  it('an input column that changed, or is gone', () => {
    const changed = goodAnswer();
    changed.input.columns = changed.input.columns.map((c) => (c.id === 'amount' ? { ...c, type: 'integer' as const } : c));
    expect(paths(changed)).toEqual(['input.columns[1]']);
    expect(problemsOf(changed)[0]!.message).toContain('"amount"');

    const gone = goodAnswer();
    gone.input.columns = gone.input.columns.filter((c) => c.id !== 'status');
    expect(paths(gone)).toContain('input.columns');
  });

  it('input.sheet, headerRow and stopAt', () => {
    const a = goodAnswer();
    a.input.headerRow = 3;
    a.input.stopAt = { when: 'firstCellMatches', values: ['Total'] };
    expect(paths(a)).toEqual(expect.arrayContaining(['input.headerRow', 'input.stopAt']));
  });

  it('a computed column that changed, or is gone', () => {
    const changed = goodAnswer();
    changed.transform.computed[0] = { id: 'gross', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 1.18 }] } };
    expect(paths(changed)).toEqual(['transform.computed[0]']);

    const gone = goodAnswer();
    gone.transform.computed = gone.transform.computed.filter((c) => c.id !== 'gross');
    expect(paths(gone)).toEqual(['transform.computed']);
  });

  it('the from of a fixed output column', () => {
    const a = goodAnswer();
    a.output.columns = a.output.columns.map((c) => (c.header === 'Gross' ? { ...c, from: 'amount' } : c));
    expect(paths(a)).toEqual(['output.columns[1].from']);
  });

  it('a header, format, width or agg of an output column, and the column count', () => {
    const a = goodAnswer();
    a.output.columns = a.output.columns.map((c) => (c.header === 'Gross' ? { header: 'Gross total', from: 'gross', format: '0.0', width: 20, agg: 'sum' as const } : c));
    expect(paths(a)).toEqual(['output.columns[1].header', 'output.columns[1].format', 'output.columns[1].width', 'output.columns[1].agg']);

    const fewer = goodAnswer();
    fewer.output.columns = fewer.output.columns.slice(0, 3);
    expect(paths(fewer)).toEqual(['output.columns']);
  });

  it('output.file, sheetName, direction, language and headerStyle', () => {
    const a = goodAnswer();
    a.output = { ...a.output, file: { type: 'csv', header: true }, sheetName: 'Other', direction: 'rtl', language: 'he', headerStyle: { bold: false } };
    expect(paths(a)).toEqual(['output.file', 'output.sheetName', 'output.direction', 'output.language', 'output.headerStyle']);
  });

  it('a row filter that changed, or one more when droppedRows is not listed', () => {
    const changed = goodAnswer();
    changed.input.rowFilters = [{ column: 'status', op: 'ne', value: 'cancelled' }];
    expect(paths(changed)).toEqual(['input.rowFilters']);

    const extra = goodAnswer();
    extra.input.rowFilters = [...(extra.input.rowFilters ?? []), { column: 'amount', op: 'gt', value: 0 }];
    expect(paths(extra)).toEqual(['input.rowFilters']);
    expect(paths(extra, { columns: [2], parts: ['droppedRows'] })).toEqual([]);
  });

  it('a check (validation) that is missing or changed', () => {
    const a = goodAnswer();
    a.validations = [{ column: 'amount', rule: 'range', min: 5, severity: 'flag' }];
    expect(paths(a)).toEqual(['validations']);
  });

  it('an unsupported entry of a fixed column that is gone (but not for a column that was listed)', () => {
    const a = goodAnswer();
    a.unsupported = [];
    expect(paths(a)).toEqual(['unsupported']);
  });

  it('a fixed value map, function and table', () => {
    const fixed = fixedRules();
    fixed.transform.valueMaps = [{ column: 'status', map: { A: 'Active' }, onMissing: 'flag' }];
    fixed.transform.functions = [{ name: 'net', params: [{ name: 'x', type: 'decimal' }], returns: 'decimal', body: { op: 'mul', args: [{ param: 'x' }, { const: 2 }] } }];
    fixed.transform.tables = [{ name: 'rates', columns: ['k', 'v'], rows: [['a', 1]] }];
    const a = { ...goodAnswer(), input: fixed.input, transform: { ...fixed.transform, computed: goodAnswer().transform.computed } };
    expect(problemsOf(a, LISTED, fixed)).toEqual([]);
    a.transform = { ...a.transform, valueMaps: [{ column: 'status', map: { A: 'Active', B: 'Blocked' }, onMissing: 'flag' }], functions: [], tables: [{ name: 'rates', columns: ['k', 'v'], rows: [['a', 2]] }] };
    expect(paths(a, LISTED, fixed)).toEqual(['transform.valueMaps', 'transform.functions', 'transform.tables[0]']);
  });
});

describe('checkFixedLock: only the listed parts may change', () => {
  it('a sort, group, title row, summary row or expand that was not asked for', () => {
    const a = goodAnswer();
    a.transform.sort = [{ column: 'id', dir: 'desc' }];
    a.transform.group = { by: 'status', showDetailRows: true };
    a.transform.expand = { mode: 'splitCell', column: 'status', separator: ',', trim: true, partId: 'part', skipEmpty: true };
    a.transform.dedupe = { keys: 'all', keep: 'first', action: 'remove' };
    a.output.titleRows = [{ text: 'Report' }, { blank: true }];
    a.output.summaryRows = [{ cells: { Gross: 'sum' } }];
    expect(paths(a)).toEqual(['transform.dedupe', 'transform.expand', 'transform.sort', 'transform.group', 'output.titleRows', 'output.summaryRows']);
  });

  it('with the part listed, the same change is allowed', () => {
    const a = goodAnswer();
    a.transform.sort = [{ column: 'id', dir: 'desc' }];
    a.transform.group = { by: 'status', showDetailRows: true };
    a.transform.expand = { mode: 'splitCell', column: 'status', separator: ',', trim: true, partId: 'part', skipEmpty: true };
    a.transform.dedupe = { keys: 'all', keep: 'first', action: 'remove' };
    a.output.titleRows = [{ text: 'Report' }, { blank: true }];
    a.output.summaryRows = [{ cells: { Gross: 'sum' } }];
    expect(problemsOf(a, { columns: [2], parts: ['sort', 'group', 'rows', 'droppedRows', 'dateTitle', 'summaryRows'] })).toEqual([]);
  });

  it('a listed part still has to keep what was fixed in it', () => {
    const fixed = fixedRules();
    fixed.transform.sort = [{ column: 'id', dir: 'asc' }];
    fixed.output.summaryRows = [{ label: 'Total', cells: { Gross: 'sum' } }];
    fixed.output.titleRows = [{ text: 'Report' }];
    const a = goodAnswer();
    a.transform.sort = [{ column: 'amount', dir: 'desc' }];
    a.output.summaryRows = [{ label: 'Sum', cells: { Gross: 'sum' } }];
    a.output.titleRows = [{ text: 'Another report' }];
    expect(paths(a, { columns: [2], parts: ['sort', 'summaryRows', 'dateTitle'] }, fixed)).toEqual(['transform.sort', 'output.titleRows', 'output.summaryRows']);
  });

  it('a fixed group: by stays unless group is listed; blankRowsAfter and its summary rows follow their own parts', () => {
    const fixed = fixedRules();
    fixed.transform.group = { by: 'status', showDetailRows: true, blankRowsAfter: 1, summaryRows: [{ label: 'Sub', cells: { Gross: 'sum' } }] };
    const same = { ...goodAnswer(), transform: { ...goodAnswer().transform, group: fixed.transform.group } };
    expect(problemsOf(same, LISTED, fixed)).toEqual([]);

    const moved = { ...same, transform: { ...same.transform, group: { by: 'id', showDetailRows: false, blankRowsAfter: 2, summaryRows: [] } } };
    expect(paths(moved, LISTED, fixed)).toEqual(['transform.group', 'transform.group.blankRowsAfter', 'transform.group.summaryRows']);
    const removed = { ...same, transform: { ...same.transform, group: undefined } };
    expect(paths(removed, LISTED, fixed)).toEqual(['transform.group']);
  });
});

describe('checkFixedLock: the listed columns', () => {
  it('a listed column left with no from and no unsupported entry', () => {
    const a = fixedRules();
    const problems = problemsOf(a);
    expect(problems.map((p) => p.path)).toEqual(['output.columns[2].from']);
    expect(problems[0]!.message).toContain('"Label"');
    expect(problems[0]!.message).toContain('unsupported');
  });

  it('a column that was not listed may not get a rule', () => {
    const a = goodAnswer();
    a.output.columns = a.output.columns.map((c) => (c.header === 'Note' ? { header: 'Note', from: 'amount' } : c));
    expect(paths(a)).toEqual(expect.arrayContaining(['output.columns[3].from']));
  });

  it('a value map on a column a fixed output column reads would change that column', () => {
    const a = goodAnswer();
    a.transform.valueMaps = [{ column: 'id', map: { A1: 'X' }, onMissing: 'keep' }];
    const problems = problemsOf(a);
    expect(problems.map((p) => p.path)).toEqual(['transform.valueMaps[0]']);
    expect(problems[0]!.message).toContain('"ID"');
    expect(problems[0]!.message).toContain('computed column');
  });

  it('a value map on a column no fixed output column reads is fine', () => {
    const a = goodAnswer();
    a.input.columns = [...a.input.columns, { id: 'group', header: 'Group', type: 'text' }];
    a.transform.valueMaps = [{ column: 'group', map: { N: 'North' }, onMissing: 'flag' }];
    expect(problemsOf(a)).toEqual([]);
  });

  it('a value map on a column a fixed computed column reads (through the output column) is caught too', () => {
    const a = goodAnswer();
    a.transform.valueMaps = [{ column: 'amount', map: { '1': '2' }, onMissing: 'keep' }];
    expect(paths(a)).toEqual(['transform.valueMaps[0]']);
  });
});
