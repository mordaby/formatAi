// Code fills the data parameters of an AI answer from every row of the example (`fillParams`, learning-loop proposal 7.1): one test per
// shape - what is filled, what is refused (a key whose rows disagree, a value not every row agrees on), the context of a lookup inside a
// condition, the cut-off's range, its round value and its visible check, bands, the day/month order proven or not, the duplicate kept,
// the values a filter drops - and completion mode, where the user's own parts are never changed.
import type { Expr, LearnResult, Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { fillParams, roundestNumber, swapDayMonth, swapDayMonthFormat } from '../../src/learn/fillParams';
import { verifyAgainstExample } from '../../src/learn/verify';
import { runRules } from '../../src/pipeline/runRules';
import type { PairAnalysis } from '../../src/learn/analyze';
import { analyzeOk, date, xlsx, type V } from './analyze/helpers';

const col = (id: string): Expr => ({ col: id });
const text = (s: string): Expr => ({ const: s });
const num = (n: number): Expr => ({ const: n });

/** A rules file: input columns (id = header lower-cased), computed columns, output columns (header <- id). */
function rulesOf(opts: {
  inputs: [string, LearnResult['input']['columns'][number]['type']][];
  computed?: LearnResult['transform']['computed'];
  out: [string, string][];
  tables?: LearnResult['transform']['tables'];
  valueMaps?: LearnResult['transform']['valueMaps'];
  dedupe?: LearnResult['transform']['dedupe'];
  rowFilters?: LearnResult['input']['rowFilters'];
  inputFormats?: Record<string, string[]>;
}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: opts.inputs.map(([header, type]) => ({ id: header.toLowerCase(), header, type, ...(opts.inputFormats?.[header] ? { inputFormats: opts.inputFormats[header] } : {}) })),
      ...(opts.rowFilters ? { rowFilters: opts.rowFilters } : {}),
    },
    transform: {
      computed: opts.computed ?? [],
      valueMaps: opts.valueMaps ?? [],
      sort: [],
      ...(opts.tables ? { tables: opts.tables } : {}),
      ...(opts.dedupe ? { dedupe: opts.dedupe } : {}),
    },
    output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: opts.out.map(([header, from]) => ({ header, from })) },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const analysisOf = (input: V[][], output: V[][]): PairAnalysis => analyzeOk(xlsx(input), xlsx(output));
const verified = (r: LearnResult, a: PairAnalysis): boolean => verifyAgainstExample(r, a).verified;

// ---------------------------------------------------------------------------
// 1. Lookup tables and value maps
// ---------------------------------------------------------------------------

/** 50 branches; the Online channel has no branch name ("Online"). Sale -> Branch name. */
function branchPair(opts: { conflict?: boolean } = {}): { input: V[][]; output: V[][]; names: Map<string, string> } {
  const names = new Map<string, string>();
  for (let b = 1; b <= 50; b++) names.set(`B${String(b).padStart(2, '0')}`, `Branch ${b} ${b % 2 ? 'North' : 'South'}`);
  const input: V[][] = [['Sale', 'Code', 'Channel']];
  const output: V[][] = [['Sale', 'Branch']];
  let i = 0;
  for (const [code, name] of names) {
    for (const channel of ['Store', 'Store', 'Online']) {
      i++;
      input.push([`S${1000 + i}`, code, channel]);
      output.push([`S${1000 + i}`, channel === 'Online' ? 'Online' : name]);
    }
  }
  // a code that only ever sells Online: its name is never shown
  input.push(['S9001', 'B99', 'Online']);
  output.push(['S9001', 'Online']);
  if (opts.conflict) {
    // B07's store rows disagree: one of them shows another name
    const at = output.findIndex((r, k) => k > 0 && input[k]![1] === 'B07' && input[k]![2] === 'Store');
    output[at] = [output[at]![0]!, 'Somewhere else'];
  }
  return { input, output, names };
}

function branchRules(entries: [string, string][]): LearnResult {
  const expr: Expr = { op: 'if', cond: { op: 'eq', args: [col('channel'), text('Online')] }, then: text('Online'), else: { op: 'lookup', table: 'branches', key: col('code'), return: 'name', onMissing: 'flag' } };
  return rulesOf({
    inputs: [['Sale', 'idLike'], ['Code', 'text'], ['Channel', 'text']],
    computed: [{ id: 'branch', type: 'text', expr }],
    tables: [{ name: 'branches', columns: ['code', 'name'], rows: entries }],
    out: [['Sale', 'sale'], ['Branch', 'branch']],
  });
}

describe('fillParams: lookup tables', () => {
  it('adds every key -> value pair the example shows, read through the rules\' own key and condition', () => {
    const p = branchPair();
    const a = analysisOf(p.input, p.output);
    const answer = branchRules([['B01', 'Branch 1 North'], ['B02', 'Branch 2 South'], ['B03', 'Branch 3 North']]);
    expect(verified(answer, a)).toBe(false);
    const r = fillParams(answer, a);
    expect(r.filled).toEqual([{ kind: 'lookup', count: 47 }]);
    const table = r.rules.transform.tables![0]!;
    expect(table.rows).toHaveLength(50);
    expect(new Map(table.rows.map((row) => [row[0], row[1]]))).toEqual(p.names);
    expect(verified(r.rules, a)).toBe(true);
    // the AI's own entries come first and are unchanged; unseen keys next month stay flagged (onMissing as the AI wrote it)
    expect(table.rows.slice(0, 3)).toEqual(answer.transform.tables![0]!.rows);
  });

  it('context: only the rows where the lookup branch is taken count - a code seen only on Online rows is not filled', () => {
    const p = branchPair();
    const r = fillParams(branchRules([]), analysisOf(p.input, p.output));
    const keys = r.rules.transform.tables![0]!.rows.map((row) => row[0]);
    expect(keys).not.toContain('B99');
    expect(r.rules.transform.tables![0]!.rows.every((row) => row[1] !== 'Online')).toBe(true);
  });

  it('refuses a key whose rows give two different values: those rows stay wrong (for the loop or the user)', () => {
    const p = branchPair({ conflict: true });
    const a = analysisOf(p.input, p.output);
    const r = fillParams(branchRules([]), a);
    const keys = r.rules.transform.tables![0]!.rows.map((row) => row[0]);
    expect(keys).toHaveLength(49);
    expect(keys).not.toContain('B07');
    const v = verifyAgainstExample(r.rules, a);
    expect(v.verified).toBe(false);
    expect(new Set(v.mismatches.map((m) => m.column))).toEqual(new Set(['Branch']));
    expect(v.mismatches).toHaveLength(2); // both B07 store rows
  });

  it('completion mode: a table that is part of the user\'s fixed rules is never changed', () => {
    const p = branchPair();
    const answer = branchRules([['B01', 'Branch 1 North']]);
    const r = fillParams(answer, analysisOf(p.input, p.output), { fixed: answer });
    expect(r.filled).toEqual([]);
    expect(r.rules).toBe(answer);
  });
});

describe('fillParams: value maps', () => {
  it('adds every value -> value pair of the example; a value whose rows disagree is left out', () => {
    const input: V[][] = [['Id', 'Code']];
    const output: V[][] = [['Id', 'Kind']];
    const kinds: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta' };
    const codes = ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'e', 'e'];
    codes.forEach((c, i) => {
      input.push([`R${i}`, c]);
      output.push([`R${i}`, kinds[c] ?? (i === 8 ? 'Eps' : 'Epsilon')]);
    });
    const answer = rulesOf({ inputs: [['Id', 'text'], ['Code', 'text']], valueMaps: [{ column: 'code', map: { a: 'Alpha' }, onMissing: 'flag' }], out: [['Id', 'id'], ['Kind', 'code']] });
    const r = fillParams(answer, analysisOf(input, output));
    expect(r.filled).toEqual([{ kind: 'valueMap', count: 3 }]);
    expect(r.rules.transform.valueMaps[0]!.map).toEqual({ a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta' });
  });
});

// ---------------------------------------------------------------------------
// 2. Value lists in conditions
// ---------------------------------------------------------------------------

describe('fillParams: value lists', () => {
  /** Status -> Active for A, B, C; Inactive for D; E is Active on one row and Inactive on another (a hand-edited row). */
  function statusPair(): { input: V[][]; output: V[][] } {
    const input: V[][] = [['Id', 'Status']];
    const output: V[][] = [['Id', 'State']];
    const rows: [string, string][] = [['A', 'Active'], ['B', 'Active'], ['C', 'Active'], ['D', 'Inactive'], ['A', 'Active'], ['C', 'Active'], ['D', 'Inactive'], ['E', 'Active'], ['E', 'Inactive']];
    rows.forEach(([s, out], i) => {
      input.push([`R${i}`, s]);
      output.push([`R${i}`, out]);
    });
    return { input, output };
  }
  const withCond = (cond: Expr): LearnResult =>
    rulesOf({ inputs: [['Id', 'text'], ['Status', 'text']], computed: [{ id: 'state', type: 'text', expr: { op: 'if', cond, then: text('Active'), else: text('Inactive') } }], out: [['Id', 'id'], ['State', 'state']] });

  it('completes an `in` list with the values every row of which agrees; a value the rows disagree on stays out', () => {
    const p = statusPair();
    const r = fillParams(withCond({ op: 'oneOf', arg: col('status'), values: ['A'] }), analysisOf(p.input, p.output));
    expect(r.filled).toEqual([{ kind: 'valueList', count: 2 }]);
    expect((r.rules.transform.computed[0]!.expr as { cond: { values: unknown[] } }).cond.values).toEqual(['A', 'B', 'C']);
  });

  it('completes an or-chain of `=` (and a single `=`) the same way', () => {
    const p = statusPair();
    const chain = fillParams(withCond({ op: 'or', args: [{ op: 'eq', args: [col('status'), text('A')] }, { op: 'eq', args: [col('status'), text('B')] }] }), analysisOf(p.input, p.output));
    expect(chain.filled).toEqual([{ kind: 'valueList', count: 1 }]);
    const single = fillParams(withCond({ op: 'eq', args: [col('status'), text('A')] }), analysisOf(p.input, p.output));
    const cond = (single.rules.transform.computed[0]!.expr as { cond: Expr }).cond;
    expect(cond).toEqual({ op: 'or', args: ['A', 'B', 'C'].map((v) => ({ op: 'eq', args: [col('status'), text(v)] })) });
  });
});

// ---------------------------------------------------------------------------
// 3-4. Cut-offs and bands
// ---------------------------------------------------------------------------

/** Amount -> Urgent at 5,000 and above, else Normal. The example's amounts around the line: 4,435 (Normal) and 5,299 (Urgent). */
function cutoffPair(): { input: V[][]; output: V[][] } {
  const amounts = [120, 900, 2300, 3100, 4435, 5299, 6323, 7000, 8800, 9100, 4000, 5900];
  const input: V[][] = [['Id', 'Amount']];
  const output: V[][] = [['Id', 'Priority']];
  amounts.forEach((x, i) => {
    input.push([`R${i}`, x]);
    output.push([`R${i}`, x >= 5000 ? 'Urgent' : 'Normal']);
  });
  return { input, output };
}
const cutRules = (op: 'gte' | 'gt', k: number): LearnResult =>
  rulesOf({ inputs: [['Id', 'text'], ['Amount', 'decimal']], computed: [{ id: 'priority', type: 'text', expr: { op: 'if', cond: { op, args: [col('amount'), num(k)] }, then: text('Urgent'), else: text('Normal') } }], out: [['Id', 'id'], ['Priority', 'priority']] });
const constOf = (r: LearnResult): unknown => ((r.transform.computed[0]!.expr as { cond: { args: [Expr, { const: number }] } }).cond.args[1] as { const: number }).const;
const checkOf = (r: LearnResult): Validation | undefined => r.validations.find((v) => v.rule === 'cutoffRange');

describe('fillParams: cut-offs', () => {
  it('a value outside the range the example leaves is replaced by the roundest number inside, and the range becomes a visible check', () => {
    const p = cutoffPair();
    const a = analysisOf(p.input, p.output);
    const r = fillParams(cutRules('gte', 5944), a);
    expect(constOf(r.rules)).toBe(5000);
    expect(checkOf(r.rules)).toEqual({ column: 'amount', rule: 'cutoffRange', low: 4435, high: 5299, value: 5000, includes: 'high', severity: 'flag' });
    expect(r.filled).toEqual([{ kind: 'cutoff', count: 1 }]);
    expect(r.checks).toBe(1);
    expect(verified(r.rules, a)).toBe(true);
  });

  it('the AI\'s value is kept when it is inside the range; the check still says what the example could not settle', () => {
    const p = cutoffPair();
    const r = fillParams(cutRules('gte', 5200), analysisOf(p.input, p.output));
    expect(constOf(r.rules)).toBe(5200);
    expect(checkOf(r.rules)).toMatchObject({ low: 4435, high: 5299, value: 5200 });
  });

  it('`>` puts the cut-off on the low edge of the range', () => {
    const p = cutoffPair();
    const r = fillParams(cutRules('gt', 6000), analysisOf(p.input, p.output));
    expect(checkOf(r.rules)).toMatchObject({ low: 4435, high: 5299, includes: 'low', value: 5000 });
  });

  it('the visible check flags next month\'s value inside the range, and nothing outside it', () => {
    const p = cutoffPair();
    const r = fillParams(cutRules('gte', 5944), analysisOf(p.input, p.output));
    const next = { sheetName: 'Sheet1', direction: 'ltr' as const, headers: ['Id', 'Amount'], rows: [[{ v: 'N1' }, { v: 4435 }], [{ v: 'N2' }, { v: 4800 }], [{ v: 'N3' }, { v: 5299 }], [{ v: 'N4' }, { v: 9000 }]], rowNumbers: [2, 3, 4, 5] };
    const run = runRules(r.rules, next);
    expect(run.ok && run.flags.map((f) => [f.rowNumber, f.messageKey])).toEqual([[3, 'flag.validation.cutoffRange']]);
  });

  it('a range of one value (neighbouring whole numbers) needs no check', () => {
    const input: V[][] = [['Id', 'Amount'], ['a', 4999], ['b', 5000], ['c', 100], ['d', 9000]];
    const output: V[][] = [['Id', 'Priority'], ['a', 'Normal'], ['b', 'Urgent'], ['c', 'Normal'], ['d', 'Urgent']];
    const r = fillParams(cutRules('gte', 7000), analysisOf(input, output));
    expect(constOf(r.rules)).toBe(5000);
    expect(checkOf(r.rules)).toBeUndefined();
    expect(r.checks).toBe(0);
  });

  it('the roundest number: fewest significant digits, then the middle', () => {
    expect(roundestNumber(4435, 5944, 'high', 0)).toBe(5000);
    expect(roundestNumber(100, 1000, 'high', 0)).toBe(1000);
    expect(roundestNumber(9000, 21000, 'high', 0)).toBe(10000);
    expect(roundestNumber(12.31, 12.39, 'high', 2)).toBe(12.35);
    expect(roundestNumber(12.31, 12.44, 'high', 2)).toBe(12.4);
    expect(roundestNumber(4999, 5000, 'low', 0)).toBe(4999);
  });
});

describe('fillParams: bands', () => {
  it('settles every boundary of a band table, each with its range', () => {
    const amounts = [50, 400, 950, 1200, 2600, 4700, 5100, 8000, 12000, 700, 3000, 6500];
    const label = (x: number): string => (x < 1000 ? 'Small' : x < 5000 ? 'Medium' : 'Large');
    const input: V[][] = [['Id', 'Amount'], ...amounts.map((x, i): V[] => [`R${i}`, x])];
    const output: V[][] = [['Id', 'Size'], ...amounts.map((x, i): V[] => [`R${i}`, label(x)])];
    const a = analysisOf(input, output);
    const expr: Expr = {
      op: 'switch',
      cases: [
        { when: { op: 'lt', args: [col('amount'), num(600)] }, then: text('Small') },
        { when: { op: 'lt', args: [col('amount'), num(7000)] }, then: text('Medium') },
      ],
      else: text('Large'),
    };
    const answer = rulesOf({ inputs: [['Id', 'text'], ['Amount', 'decimal']], computed: [{ id: 'size', type: 'text', expr }], out: [['Id', 'id'], ['Size', 'size']] });
    const r = fillParams(answer, a);
    expect(r.filled).toEqual([{ kind: 'band', count: 2 }]);
    expect(r.rules.validations.filter((v) => v.rule === 'cutoffRange')).toEqual([
      { column: 'amount', rule: 'cutoffRange', low: 950, high: 1200, value: 1000, includes: 'high', severity: 'flag' },
      { column: 'amount', rule: 'cutoffRange', low: 4700, high: 5100, value: 5000, includes: 'high', severity: 'flag' },
    ]);
    expect(verified(r.rules, a)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Day/month order of text dates
// ---------------------------------------------------------------------------

describe('fillParams: the day/month order of text dates', () => {
  const datePair = (texts: string[]): { input: V[][]; output: V[][] } => {
    const input: V[][] = [['Id', 'When'], ...texts.map((t, i): V[] => [`R${i}`, t])];
    const output: V[][] = [['Id', 'Month'], ...texts.map((t, i): V[] => [`R${i}`, Number(t.split('/')[1])])];
    return { input, output };
  };
  const toDateRules = (format: string): LearnResult =>
    rulesOf({
      inputs: [['Id', 'text'], ['When', 'text']],
      computed: [{ id: 'month', type: 'integer', expr: { op: 'datePart', arg: { op: 'toDate', arg: col('when'), format }, part: 'month' } }],
      out: [['Id', 'id'], ['Month', 'month']],
    });

  it('a value with a part above 12 proves the order: the other order is used', () => {
    const p = datePair(['05/03/2026', '13/04/2026', '02/01/2026']);
    const a = analysisOf(p.input, p.output);
    const r = fillParams(toDateRules('MM/DD/YYYY'), a);
    expect(r.filled).toEqual([{ kind: 'dayMonthOrder', count: 1 }]);
    expect(JSON.stringify(r.rules)).toContain('"format":"DD/MM/YYYY"');
    expect(r.ambiguities).toEqual([]);
    expect(verified(r.rules, a)).toBe(true);
  });

  it('no value proves it: the AI\'s choice is kept and reported for the ambiguity question; swapDayMonth applies the other reading', () => {
    const p = datePair(['05/03/2026', '01/04/2026', '02/01/2026']);
    const answer = toDateRules('DD/MM/YYYY');
    const r = fillParams(answer, analysisOf(p.input, p.output));
    expect(r.filled).toEqual([]);
    expect(r.ambiguities).toEqual([{ kind: 'dayMonthOrder', column: 'When', format: 'DD/MM/YYYY', other: 'MM/DD/YYYY' }]);
    expect(JSON.stringify(swapDayMonth(r.rules, r.ambiguities[0]!))).toContain('"format":"MM/DD/YYYY"');
  });

  it('input formats are settled the same way', () => {
    const p = datePair(['05/03/2026', '13/04/2026']);
    const output: V[][] = [['Id', 'When'], ['R0', date(2026, 3, 5)], ['R1', date(2026, 4, 13)]];
    const answer = rulesOf({ inputs: [['Id', 'text'], ['When', 'date']], inputFormats: { When: ['MM/DD/YYYY'] }, out: [['Id', 'id'], ['When', 'when']] });
    const r = fillParams(answer, analysisOf(p.input, output));
    expect(r.rules.input.columns[1]!.inputFormats).toEqual(['DD/MM/YYYY']);
  });

  it('swaps day and month tokens only', () => {
    expect(swapDayMonthFormat('DD/MM/YYYY')).toBe('MM/DD/YYYY');
    expect(swapDayMonthFormat('D.M.YY')).toBe('M.D.YY');
    expect(swapDayMonthFormat('YYYY-MM-DD')).toBe('YYYY-DD-MM');
    expect(swapDayMonthFormat('D בMMMM YYYY')).toBeNull();
    expect(swapDayMonthFormat('MM/YYYY')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Which duplicate is kept, which values a filter drops
// ---------------------------------------------------------------------------

describe('fillParams: the duplicate kept and the values a filter drops', () => {
  it('keeps the other duplicate when that makes the rows right', () => {
    const input: V[][] = [['Order', 'Version'], ['O1', 1], ['O2', 1], ['O1', 2], ['O3', 1], ['O2', 2]];
    // the example keeps the latest version of each order, in file order
    const output: V[][] = [['Order', 'Version'], ['O1', 2], ['O3', 1], ['O2', 2]];
    const answer = rulesOf({ inputs: [['Order', 'text'], ['Version', 'integer']], dedupe: { keys: ['order'], keep: 'first', action: 'remove' }, out: [['Order', 'order'], ['Version', 'version']] });
    const a = analysisOf(input, output);
    const r = fillParams(answer, a);
    expect(r.filled).toEqual([{ kind: 'dedupeKeep', count: 1 }]);
    expect(r.rules.transform.dedupe?.keep).toBe('last');
  });

  it('adds the values a filter drops when every row of them was dropped', () => {
    const statuses = ['Open', 'Cancelled', 'Open', 'Void', 'Done', 'Cancelled', 'Void', 'Open'];
    const input: V[][] = [['Id', 'Status'], ...statuses.map((s, i): V[] => [`R${i}`, s])];
    const output: V[][] = [['Id', 'Status'], ...statuses.flatMap((s, i): V[][] => (s === 'Cancelled' || s === 'Void' ? [] : [[`R${i}`, s]]))];
    const answer = rulesOf({ inputs: [['Id', 'text'], ['Status', 'text']], rowFilters: [{ column: 'status', op: 'ne', value: 'Cancelled' }], out: [['Id', 'id'], ['Status', 'status']] });
    const a = analysisOf(input, output);
    const r = fillParams(answer, a);
    expect(r.filled).toEqual([{ kind: 'filterList', count: 1 }]);
    expect(r.rules.input.rowFilters).toEqual([{ column: 'status', op: 'notOneOf', value: ['Cancelled', 'Void'] }]);
    expect(verified(r.rules, a)).toBe(true);
  });
});

describe('fillParams: nothing to fill', () => {
  it('an answer that already verifies and has no comparison comes back as it is', () => {
    const p = branchPair();
    const a = analysisOf(p.input, p.output);
    const answer = branchRules([...p.names]);
    const r = fillParams(answer, a);
    expect(r).toEqual({ rules: answer, filled: [], checks: 0, ambiguities: [] });
  });
});
