// The constant guard (SPEC 6.2 step 4, 6.5): a column that holds ONE value on every row is accepted as a constant only when the
// input cannot write that value as well. A "03/2026" in every row of a March file is the month of the data as likely as a fixed
// label, and a constant is wrong next month. The example cannot say which, the AI step sees the same rows, and the user knows: so the
// column is built from its DATA reading (it follows next month's data), the competing readings come back as rule fragments, and the
// result screen asks (SPEC 8.11, 21 v12 item 11). A column whose data has no reading code can write as a rule (a date column that mixes
// several formats) is still not built and goes to the AI step. A real label, or a fixed value no input column can write, is still built
// locally, as a constant, with no question. Synthetic, domain-neutral data.
import { describe, expect, it } from 'vitest';
import { isDerivedColumn, isExternalColumn, type PairAnalysis } from '../../../src/learn/analyze';
import { completionPlan } from '../../../src/learn/complete';
import { ambiguousColumns, fastPath, type FastPathSuccess } from '../../../src/learn/fastPath';
import { relationsToHints } from '../../../src/learn/hints';
import { partialRules, type PartialRulesResult } from '../../../src/learn/partial';
import { preflight } from '../../../src/learn/preflight';
import { isReadingCheck, type AmbiguousColumn } from '../../../src/learn/readings';
import { verifyAgainstExample } from '../../../src/learn/verify';
import type { LearnResult } from '@formatai/shared';
import { runOk, table, values } from '../../pipeline/helpers';
import { analyzeOk, date, findRel, xlsx, type V } from './helpers';

const N = 24;

/** The i-th March 2026 date written the way a different person typed it: a real date, day/month text, ISO text, a Hebrew month name. */
function marchDate(i: number, mixed: boolean): V {
  const d = 1 + ((i * 5) % 28);
  const dd = String(d).padStart(2, '0');
  if (!mixed) return date(2026, 3, d);
  switch (i % 4) {
    case 0:
      return date(2026, 3, d);
    case 1:
      return `${dd}/03/2026`;
    case 2:
      return `2026-03-${dd}`;
    default:
      return `${d} במרץ 2026`;
  }
}

interface Options {
  /** How the `When` input column is written. */
  mixed?: boolean;
  /** Rows (0-based) whose `When` cell is empty. */
  emptyWhen?: number[];
}

/** Input: Ref, Item, When (March 2026 dates), Group ("North" on every row), Code ("REF-nnnn"). Output: Ref, Item, then `extra`. */
function pairWith(extra: { header: string; value: V }, opts: Options = {}): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Ref', 'Item', 'When', 'Group', 'Code']];
  const output: V[][] = [['Ref', 'Item', extra.header]];
  for (let i = 0; i < N; i++) {
    const ref = `R-${1000 + i * 7}`;
    const item = `Item ${String.fromCharCode(65 + (i % 26))}${i}`;
    input.push([ref, item, opts.emptyWhen?.includes(i) ? null : marchDate(i, opts.mixed ?? false), 'North', `REF-${String(7 + i * 13).padStart(4, '0')}`]);
    output.push([ref, item, extra.value]);
  }
  return { input, output };
}

function analyze(pair: { input: V[][]; output: V[][] }): { a: PairAnalysis; pf: ReturnType<typeof preflight> } {
  const a = analyzeOk(xlsx(pair.input), xlsx(pair.output));
  return { a, pf: preflight(a, 'paid') };
}

function partialOf(a: PairAnalysis, pf: ReturnType<typeof preflight>): PartialRulesResult {
  const p = partialRules(a, pf);
  if ('reason' in p) throw new Error(`partialRules failed: ${p.reason}`);
  return p;
}

function builtOf(a: PairAnalysis, pf: ReturnType<typeof preflight>): FastPathSuccess {
  const fp = fastPath(a, pf);
  if (!('rules' in fp)) throw new Error(`the fast path did not build: ${fp.reason}`);
  return fp;
}

/** The rules with the output column `column.header` read the way `column.readings[index]` says (what the result screen's answer does). */
function answered(rules: LearnResult, column: AmbiguousColumn, index: number): LearnResult {
  const reading = column.readings[index]!;
  const fragment = reading.fragment;
  const used = new Set([...rules.input.columns.map((c) => c.id), ...rules.transform.computed.map((c) => c.id)]);
  // (the ids of a fragment are its own: any that the rules already use are renamed)
  const rename = new Map<string, string>();
  const idOf = (id: string): string => {
    let next = id;
    for (let n = 2; used.has(next); n++) next = `${id}${n}`;
    used.add(next);
    rename.set(id, next);
    return next;
  };
  const input = [...rules.input.columns];
  for (const c of fragment.inputColumns) {
    const have = input.find((x) => x.header === c.header);
    if (have) rename.set(c.id, have.id);
    else input.push({ ...c, id: idOf(c.id) });
  }
  const swap = (e: unknown): unknown => {
    if (Array.isArray(e)) return e.map(swap);
    if (typeof e !== 'object' || e === null) return e;
    return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, k === 'col' && typeof v === 'string' ? (rename.get(v) ?? v) : swap(v)]));
  };
  const computed = fragment.computed.map((c) => ({ ...c, id: idOf(c.id), expr: swap(c.expr) as typeof c.expr }));
  const from = rename.get(fragment.from) ?? fragment.from;
  return {
    ...rules,
    input: { ...rules.input, columns: input },
    transform: { ...rules.transform, computed: [...rules.transform.computed, ...computed] },
    output: { ...rules.output, columns: rules.output.columns.map((c) => (c.header === column.header ? { ...c, from } : c)) },
    validations: rules.validations.filter((v) => !isReadingCheck(v, column)),
  };
}

/** The column is not a constant: nothing is built from a constant, and it is a question for the user (its readings come back as fragments). */
function expectAsked(pair: { input: V[][]; output: V[][] }, header: string, kinds: string[]) {
  const { a, pf } = analyze(pair);
  const out = a.columns.findIndex((c) => c.header === header);
  const ca = a.columns[out]!;
  expect(findRel(a, out, 'constant')).toBeUndefined();
  expect(ca.derivableConstant).toBeDefined();

  const asked = ambiguousColumns(a);
  expect(asked).toHaveLength(1);
  const column = asked[0]!;
  expect(column).toMatchObject({ out, header, defaultReading: 1 });
  expect(column.readings.map((r) => r.kind)).toEqual(['constant', ...kinds]);
  // The check that goes with an unanswered question: the output column must stay the constant, a row where it differs is flagged.
  expect(column.check).toEqual({ on: 'output', column: header, rule: 'oneOf', values: [String(column.value)], severity: 'flag' });

  // The strict path builds it from the DATA reading, with the check, and says which columns are questions.
  const fp = builtOf(a, pf);
  expect(fp.ambiguous).toEqual([column]);
  const built = fp.rules.output.columns.find((c) => c.header === header)!;
  expect(built.from).not.toBeNull();
  expect(fp.rules.transform.computed.every((c) => !('const' in c.expr))).toBe(true);
  expect(fp.rules.validations.filter((v) => isReadingCheck(v, column))).toHaveLength(1);
  expect(verifyAgainstExample(fp.rules, a).verified).toBe(true);

  // Both readings are ready to apply and fit every row of the example.
  for (const index of column.readings.keys()) {
    const rules = answered(fp.rules, column, index);
    expect(verifyAgainstExample(rules, a).verified, `reading ${index}`).toBe(true);
  }
  // The constant reading is the value; it is a constant.
  const constant = answered(fp.rules, column, 0);
  const constantId = constant.output.columns.find((c) => c.header === header)!.from;
  expect(constant.transform.computed.find((c) => c.id === constantId)?.expr).toEqual({ const: column.value });

  // The partial result builds it too: it is solved, never "missing" for the AI step, and carries the same question.
  const p = partialOf(a, pf);
  expect(p.solved).toEqual(['Ref', 'Item', header]);
  expect(p.needsAi).toEqual([]);
  expect(p.external).toEqual([]);
  expect(p.ambiguous).toEqual([column]);
  expect(completionPlan(p.rules).columns).toEqual([]);
  return { a, pf, ca, out, column, fp };
}

/** The column is not a constant, and no reading of its data can be written as a rule: nothing is built and there is no question. */
function expectNotBuilt(pair: { input: V[][]; output: V[][] }, header: string) {
  const { a, pf } = analyze(pair);
  const out = a.columns.findIndex((c) => c.header === header);
  const ca = a.columns[out]!;
  expect(findRel(a, out, 'constant')).toBeUndefined();
  expect(ca.derivableConstant).toBeDefined();
  expect(ambiguousColumns(a)).toEqual([]);
  expect(fastPath(a, pf)).toEqual({ reason: 'ambiguousColumn', params: { column: out } });
  const p = partialOf(a, pf);
  expect(p.solved).toEqual(['Ref', 'Item']);
  expect(p.needsAi).toEqual([header]);
  expect(p.external).toEqual([]);
  expect(p.ambiguous).toEqual([]);
  expect(p.rules.output.columns.find((c) => c.header === header)!.from).toBeNull();
  expect(completionPlan(p.rules).columns).toEqual([out]);
  return { a, pf, ca, out };
}

describe('a month or year of the data is not a constant', () => {
  it('a month label over a column that mixes date formats (real dates, day/month text, ISO text, Hebrew month names): no reading code can write, so no question', () => {
    const { a, pf, ca, out } = expectNotBuilt(pairWith({ header: 'Period', value: '03/2026' }, { mixed: true }), 'Period');
    // No relation reads such a column as a date, so nothing explains Period: it depends on the date column (a hint), it is not "another source".
    expect(ca.relations).toEqual([]);
    expect(ca.derivableConstant).toEqual([2]);
    expect(ca.derived).toMatchObject({ kind: 'category', in: [2] });
    expect(isDerivedColumn(ca)).toBe(true);
    expect(isExternalColumn(ca)).toBe(false);
    expect(relationsToHints(a, pf).find((h) => 'out' in h && h.out === out)).toEqual({ rel: 'dependsOn', in: [2], out, coverage: 1 });
  });

  it('a month label over a clean date column: the constant or the date format - a question, the data reading kept until it is answered', () => {
    const { a, pf, ca, out, column } = expectAsked(pairWith({ header: 'Period', value: '03/2026' }), 'Period', ['dateFormat']);
    expect(ca.derivableConstant).toEqual([2]);
    expect(findRel(a, out, 'dateFormat')).toMatchObject({ in: [2], to: 'MM/YYYY', coverage: 1 });
    expect(relationsToHints(a, pf).find((h) => 'out' in h && h.out === out)).toMatchObject({ rel: 'dateFormat', in: [2], to: 'MM/YYYY' });
    expect(column.readings[1]).toMatchObject({ kind: 'dateFormat', columns: ['When'] });
    expect(column.readings[1]!.fragment.computed).toEqual([{ id: 'period', type: 'text', expr: { op: 'dateFormat', arg: { col: 'when' }, format: 'MM/YYYY' } }]);
    expect(column.readings[1]!.fragment.inputColumns.map((c) => c.header)).toEqual(['When']);
  });

  it('other renderings of the month or the year over a mixed date column: no question either', () => {
    for (const [header, value] of [['Month', '2026-03'], ['Name', 'March'], ['Year', 2026], ['Year text', '2026']] as const) {
      const { a, pf } = analyze(pairWith({ header, value }, { mixed: true }));
      expect(a.columns[2]!.derivableConstant, header).toEqual([2]);
      expect(ambiguousColumns(a), header).toEqual([]);
      expect(fastPath(a, pf), header).toEqual({ reason: 'ambiguousColumn', params: { column: 2 } });
    }
  });

  it('a year label over a clean date column: the year as text is a reading (a number is not: the example holds a number, a text would differ)', () => {
    const { column } = expectAsked(pairWith({ header: 'Year text', value: '2026' }), 'Year text', ['dateFormat']);
    expect(column.readings[1]!.fragment.computed[0]!.expr).toMatchObject({ op: 'dateFormat', format: 'YYYY' });
    const { a, pf } = analyze(pairWith({ header: 'Year', value: 2026 }));
    expect(a.columns[2]!.derivableConstant).toEqual([2]);
    expect(ambiguousColumns(a)).toEqual([]);
    expect(fastPath(a, pf)).toEqual({ reason: 'ambiguousColumn', params: { column: 2 } });
  });
});

describe('a value the input holds as it is is not a constant either', () => {
  it('a copy: the input column holds the same value on every row', () => {
    const { a, ca, out, column } = expectAsked(pairWith({ header: 'Area', value: 'North' }), 'Area', ['copy']);
    expect(ca.derivableConstant).toEqual([3]);
    expect(findRel(a, out, 'copy')).toMatchObject({ in: [3], coverage: 1 });
    expect(column.readings[1]).toMatchObject({ kind: 'copy', columns: ['Group'] });
    expect(column.readings[1]!.fragment).toMatchObject({ from: 'group', computed: [] });
  });

  it('a fixed part of an input text: the prefix every code starts with', () => {
    const { a, ca, out, column } = expectAsked(pairWith({ header: 'Kind', value: 'REF' }), 'Kind', ['substr']);
    expect(ca.derivableConstant).toEqual([4]);
    expect(findRel(a, out, 'substr')).toMatchObject({ in: [4], from: 'start', length: 3 });
    expect(column.readings[1]!.fragment.computed).toEqual([{ id: 'kind', type: 'text', expr: { op: 'substr', arg: { col: 'code' }, start: 1, length: 3 } }]);
  });

  it('a number that is the first digits of an id: the constant or the prefix', () => {
    const rows: V[][] = [['Ref', 'Item', 'Employee']];
    const out: V[][] = [['Ref', 'Item', 'Branch']];
    for (let i = 0; i < N; i++) {
      rows.push([`R-${1000 + i * 7}`, `Item ${i}`, `00${3100 + i * 17}`]);
      out.push([`R-${1000 + i * 7}`, `Item ${i}`, '00']);
    }
    const { column } = expectAsked({ input: rows, output: out }, 'Branch', ['substr']);
    expect(column.readings[1]).toMatchObject({ kind: 'substr', columns: ['Employee'] });
  });

  it('the example cannot tell an id prefix from a fixed branch code: the data reading is the default, the constant is the other', () => {
    const rows: V[][] = [['Ref', 'Item', 'Employee']];
    const out: V[][] = [['Ref', 'Item', 'Branch']];
    for (let i = 0; i < N; i++) {
      rows.push([`R-${1000 + i * 7}`, `Item ${i}`, `31${1000 + i * 17}`]);
      out.push([`R-${1000 + i * 7}`, `Item ${i}`, '31']);
    }
    const { column, fp } = expectAsked({ input: rows, output: out }, 'Branch', ['substr']);
    // Built from the data reading until the user answers: the column reads Employee, and the check keeps the constant in view.
    const built = fp.rules.output.columns.find((c) => c.header === 'Branch')!.from;
    expect(fp.rules.transform.computed.find((c) => c.id === built)?.expr).toMatchObject({ op: 'substr', arg: { col: 'employee' }, start: 1, length: 2 });
    expect(column.check).toEqual({ on: 'output', column: 'Branch', rule: 'oneOf', values: ['31'], severity: 'flag' });
  });
});

describe('with another column the free engine cannot build', () => {
  it('only the other column is missing for the AI step: the question is the user\'s, the completion plan does not list it', () => {
    const input: V[][] = [['Ref', 'Item', 'Employee']];
    const output: V[][] = [['Ref', 'Branch', 'Note', 'Item']];
    for (let i = 0; i < N; i++) {
      input.push([`R-${1000 + i * 7}`, `Item ${i}`, `31${1000 + i * 17}`]);
      // (a note nothing in the input can write)
      output.push([`R-${1000 + i * 7}`, '31', `${String.fromCharCode(97 + ((i * 7) % 26))}${(i * 131) % 977}`, `Item ${i}`]);
    }
    const { a, pf } = analyze({ input, output });
    expect(fastPath(a, pf)).toMatchObject({ reason: 'columnNotFullyExplained' });
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Ref', 'Branch', 'Item']);
    expect(p.needsAi).toEqual(['Note']);
    expect(p.ambiguous.map((c) => c.header)).toEqual(['Branch']);
    expect(completionPlan(p.rules).columns).toEqual([2]);
    // The question's check is in the partial rules, deletable like any check.
    expect(p.rules.validations.filter((v) => isReadingCheck(v, p.ambiguous[0]!))).toHaveLength(1);
  });
});

describe('an unanswered question at run time', () => {
  // The example: every employee id starts with "31" and the Branch column says "31". Next month a "32" comes in.
  const example = (): { input: V[][]; output: V[][] } => {
    const rows: V[][] = [['Ref', 'Item', 'Employee']];
    const out: V[][] = [['Ref', 'Item', 'Branch']];
    for (let i = 0; i < N; i++) {
      rows.push([`R-${1000 + i * 7}`, `Item ${i}`, `31${1000 + i * 17}`]);
      out.push([`R-${1000 + i * 7}`, `Item ${i}`, '31']);
    }
    return { input: rows, output: out };
  };
  const nextMonth = table(
    ['Ref', 'Item', 'Employee'],
    [
      ['R-1', 'Item 1', '311234'],
      ['R-2', 'Item 2', '321234'],
      ['R-3', 'Item 3', '319999'],
    ],
  );

  it('the data reading writes what the data says, and a row where it differs from the constant is flagged (the check is the rules\' own)', () => {
    const { a, pf } = analyze(example());
    const { rules } = builtOf(a, pf);
    const ran = runOk(rules, nextMonth);
    expect(values(ran.sheet).map((r) => r[2])).toEqual(['31', '32', '31']);
    expect(ran.flags.map((f) => ({ row: f.rowNumber, column: f.column, rule: f.rule, value: f.value }))).toEqual([{ row: 3, column: 'Branch', rule: 'oneOf', value: '32' }]);
  });

  it('answered "always the constant": the column is the constant and nothing is flagged', () => {
    const { a, pf } = analyze(example());
    const fp = builtOf(a, pf);
    const rules = answered(fp.rules, fp.ambiguous![0]!, 0);
    const ran = runOk(rules, nextMonth);
    expect(values(ran.sheet).map((r) => r[2])).toEqual(['31', '31', '31']);
    expect(ran.flags).toEqual([]);
  });

  it('answered "what the data says": the check is gone, so nothing is flagged', () => {
    const { a, pf } = analyze(example());
    const fp = builtOf(a, pf);
    const rules = answered(fp.rules, fp.ambiguous![0]!, 1);
    const ran = runOk(rules, nextMonth);
    expect(values(ran.sheet).map((r) => r[2])).toEqual(['31', '32', '31']);
    expect(ran.flags).toEqual([]);
  });
});

describe('a real constant is still built locally', () => {
  it('a label no input column can write', () => {
    const { a, pf } = analyze(pairWith({ header: 'Source', value: 'Import' }, { mixed: true }));
    const out = a.columns.findIndex((c) => c.header === 'Source');
    expect(a.columns[out]!.derivableConstant).toBeUndefined();
    expect(findRel(a, out, 'constant')).toMatchObject({ value: 'Import', coverage: 1 });
    expect(ambiguousColumns(a)).toEqual([]);
    const p = partialOf(a, pf);
    expect(p.solved).toEqual(['Ref', 'Item', 'Source']);
    expect(p.needsAi).toEqual([]);
    expect(p.ambiguous).toEqual([]);
    const fp = fastPath(a, pf);
    expect('rules' in fp).toBe(true);
    if ('rules' in fp) {
      expect(fp.rules.transform.computed.find((c) => c.id === 'source')?.expr).toEqual({ const: 'Import' });
      // No question, no check.
      expect(fp.ambiguous).toBeUndefined();
      expect(fp.rules.validations.some((v) => v.rule === 'oneOf')).toBe(false);
    }
  });

  it('a fixed number that is no part of any date', () => {
    const { a, pf } = analyze(pairWith({ header: 'Version', value: 7 }, { mixed: true }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect(ambiguousColumns(a)).toEqual([]);
    expect('rules' in fastPath(a, pf)).toBe(true);
  });

  it('a "month" the dates do not give: the label says another month', () => {
    const { a, pf } = analyze(pairWith({ header: 'Period', value: '09/2025' }, { mixed: true }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect(ambiguousColumns(a)).toEqual([]);
    expect('rules' in fastPath(a, pf)).toBe(true);
  });

  it('on EVERY row only: one row without a date cannot write the value, so the example needs the constant', () => {
    const { a, pf } = analyze(pairWith({ header: 'Period', value: '03/2026' }, { mixed: true, emptyWhen: [3] }));
    expect(a.columns[2]!.derivableConstant).toBeUndefined();
    expect(findRel(a, 2, 'constant')).toMatchObject({ value: '03/2026', coverage: 1 });
    expect(ambiguousColumns(a)).toEqual([]);
    expect('rules' in fastPath(a, pf)).toBe(true);
  });
});
