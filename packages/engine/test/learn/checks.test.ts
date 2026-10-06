// The AI code checks (docs/proposals/ai-code-checks.md, learn-v9): code answers the AI step's questions on EVERY aligned row of the example,
// masked like the samples, within the learn's row limit, with errors as answers. The pair: Class = Small / Medium / Big by Total (Qty x
// Price), where Total is itself an output column (`checksFixtures.ts`).
import type { Check, CheckAnswer, DependsOnAnswer, RangesAnswer, RowsAnswer, TestAnswer, ValuesAnswer } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { answerChecks, withoutRows, type CheckContext } from '../../src/learn/checks';
import { createMasker, type Masker } from '../../src/learn/mask';
import { analyzeOk, xlsx } from './analyze/helpers';
import { classOf, classPair, classRules, totalsOf } from './checksFixtures';

const pair = classPair(60);
const analysis = analyzeOk(xlsx(pair.input), xlsx(pair.output));
const totals = totalsOf(pair);
const counts = { Small: 0, Medium: 0, Big: 0 } as Record<string, number>;
for (const t of totals) counts[classOf(t)]! += 1;

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return { analysis, sent: new Set(), rowBudget: 40, ...over };
}

function one(check: Check, over: Partial<CheckContext> = {}): CheckAnswer {
  const r = answerChecks([check], ctx(over));
  expect(r.answers).toHaveLength(1);
  return r.answers[0]!;
}

const RIGHT_RULE = 'if(out2 < 1000, "Small", if(out2 < 5000, "Medium", "Big"))';

describe('the example and the pair (sanity)', () => {
  it('every row is aligned and every class appears', () => {
    expect(analysis.alignment.rows).toHaveLength(60);
    expect(counts.Small).toBeGreaterThan(3);
    expect(counts.Medium).toBeGreaterThan(3);
    expect(counts.Big).toBeGreaterThan(3);
  });
});

describe('test: does this rule give this output column, on every row', () => {
  it('a right rule matches every row and shows no row', () => {
    const a = one({ check: 'test', column: 'Class', rule: RIGHT_RULE }) as TestAnswer;
    expect(a).toEqual({ rows: 60, matched: 60, failing: [] });
  });

  it('a wrong cut-off: the exact count, and up to 3 failing rows in the samples\' shape with what was expected and what the rule gave', () => {
    const wrong = totals.filter((t) => classOf(t) !== classOf(t, 2000)).length;
    const r = answerChecks([{ check: 'test', column: 'Class', rule: 'if(out2 < 2000, "Small", if(out2 < 5000, "Medium", "Big"))' }], ctx());
    const a = r.answers[0] as TestAnswer;
    expect(a.rows).toBe(60);
    expect(a.matched).toBe(60 - wrong);
    expect(a.failing).toHaveLength(Math.min(3, wrong));
    for (const f of a.failing) {
      expect(f.expected).toBe('Medium');
      expect(f.got).toBe('Small');
      expect(f.row.in).toHaveLength(5);
      expect(f.row.out).toHaveLength(4);
      expect((f.row.out as unknown[])[3]).toBe('Medium');
    }
    // Rows shown count: they were not sent before.
    expect(r.rowsShown).toHaveLength(a.failing.length);
  });

  it('compares like the full verification: a number is not text that reads like it', () => {
    const a = one({ check: 'test', column: 'Total', rule: 'toText(round(in2 * in3, 2))' }) as TestAnswer;
    expect(a.matched).toBe(0);
    const b = one({ check: 'test', column: 'Total', rule: 'round(in2 * in3, 2)' }) as TestAnswer;
    expect(b.matched).toBe(60);
  });

  it('let: helper columns, a later one reading an earlier one', () => {
    const a = one({
      check: 'test',
      column: 'Class',
      let: [
        { id: 'total', expr: 'round(in2 * in3, 2)' },
        { id: 'small', expr: 'total < 1000' },
      ],
      rule: 'if(small, "Small", if(total < 5000, "Medium", "Big"))',
    }) as TestAnswer;
    expect(a).toMatchObject({ rows: 60, matched: 60 });
  });

  it('where: only the rows where it is true are checked', () => {
    const open = pair.input.slice(1).filter((r) => r[4] === 'Open').length;
    const a = one({ check: 'test', column: 'Class', rule: RIGHT_RULE, where: 'in4 = "Open"' }) as TestAnswer;
    expect(a).toEqual({ rows: open, matched: open, failing: [] });
  });

  it('column must be an output column', () => {
    expect(one({ check: 'test', column: 'in2', rule: 'in2' })).toEqual({ error: expect.stringContaining('is not an output column') });
  });
});

describe('ranges: sorted by a number, where does the column change (exact runs, no merging)', () => {
  it('by an output header: three clean runs with their exact from / to and rows', () => {
    const a = one({ check: 'ranges', column: 'Class', by: 'Total' }) as RangesAnswer;
    expect(a.clean).toBe(true);
    if (!a.clean) return;
    expect(a.noValue).toBe(0);
    expect(a.runs.map((r) => r.value)).toEqual(['Small', 'Medium', 'Big']);
    const small = totals.filter((t) => t < 1000);
    const medium = totals.filter((t) => t >= 1000 && t < 5000);
    const big = totals.filter((t) => t >= 5000);
    expect(a.runs[0]).toEqual({ from: Math.min(...small), to: Math.max(...small), value: 'Small', rows: small.length });
    expect(a.runs[1]).toEqual({ from: Math.min(...medium), to: Math.max(...medium), value: 'Medium', rows: medium.length });
    expect(a.runs[2]).toEqual({ from: Math.min(...big), to: Math.max(...big), value: 'Big', rows: big.length });
  });

  it('the class-by-total case in completion mode: by the user\'s computed total (value2) gives 3 clean runs', () => {
    const fixedRules = classRules({ withoutClass: true });
    const a = one({ check: 'ranges', column: 'Class', by: 'value2' }, { fixedRules }) as RangesAnswer;
    expect(a).toMatchObject({ clean: true, rows: 60 });
    expect(a.clean && a.runs.map((r) => [r.value, r.rows])).toEqual([
      ['Small', counts.Small],
      ['Medium', counts.Medium],
      ['Big', counts.Big],
    ]);
    // ... and the user's input ids work inside formulas too
    const t = one({ check: 'test', column: 'Class', rule: 'if(value2 < 1000, "Small", if(qty * price < 5000, "Medium", "Big"))' }, { fixedRules }) as TestAnswer;
    expect(t.matched).toBe(60);
  });

  it('by a let (a computed column of the check itself)', () => {
    const a = one({ check: 'ranges', column: 'Class', by: 'total', let: [{ id: 'total', expr: 'in2 * in3' }] }) as RangesAnswer;
    expect(a.clean && a.runs).toHaveLength(3);
  });

  it('not a function of by: clean false with the run count, and how many by values give two values', () => {
    // Customer by quantity: each quantity has one customer here, but the line changes more than 12 times
    const a = one({ check: 'ranges', column: 'Customer', by: 'in2' }) as RangesAnswer;
    expect(a.clean).toBe(false);
    if (a.clean) return;
    expect(a.runCount).toBeGreaterThan(limits.learn.checks.maxRuns);
    expect(a.mixed).toBe(0);
    // Status by quantity: one quantity has two statuses
    const b = one({ check: 'ranges', column: 'in4', by: 'in2' }) as RangesAnswer;
    expect(b).toMatchObject({ clean: false, rows: 60 });
    expect(!b.clean && b.mixed).toBeGreaterThan(0);
  });

  it('a by that holds no numbers is an error answer', () => {
    expect(one({ check: 'ranges', column: 'Class', by: 'Customer' })).toEqual({ error: expect.stringContaining('holds no numbers or dates') });
  });
});

describe('dependsOn: does the same value of these columns always give the same value', () => {
  it('Class does not depend on Customer: the keys, the agreeing rows, the conflicts, and 2 conflicting pairs of rows', () => {
    const r = answerChecks([{ check: 'dependsOn', column: 'Class', on: ['Customer'] }], ctx());
    const a = r.answers[0] as DependsOnAnswer;
    expect(a.keys).toBe(5);
    expect(a.keysConflict).toBeGreaterThan(0);
    expect(a.rowsAgree + 0).toBeLessThan(60);
    expect(a.conflicts).toHaveLength(2);
    for (const c of a.conflicts) {
      expect(c.key).toHaveLength(1);
      expect(c.values[0]).not.toEqual(c.values[1]);
      expect(c.rows).toHaveLength(2);
    }
    expect(r.rowsShown.length).toBeLessThanOrEqual(4);
  });

  it('two columns, and a where slice', () => {
    const a = one({ check: 'dependsOn', column: 'Class', on: ['in2', 'in3'], where: 'in2 > 3' }) as DependsOnAnswer;
    expect(a.keysConflict).toBe(0);
    expect(a.rowsAgree).toBe(a.rows);
    expect(a.conflicts).toEqual([]);
  });
});

describe('values and rows', () => {
  it('values: distinct and empty counts, the most common values with counts, min and max of numbers', () => {
    const a = one({ check: 'values', column: 'Class' }) as ValuesAnswer;
    expect(a.distinct).toBe(3);
    expect(a.empty).toBe(0);
    expect(a.top.map((t) => t.rows).reduce((x, y) => x + y)).toBe(60);
    expect(a.min).toBeUndefined();
    const t = one({ check: 'values', column: 'Total' }) as ValuesAnswer;
    expect(t.min).toBe(Math.min(...totals));
    expect(t.max).toBe(Math.max(...totals));
    expect(t.top.length).toBeLessThanOrEqual(limits.learn.checks.maxValues);
  });

  it('rows: the first rows where the condition holds, in file order, at most limit', () => {
    const r = answerChecks([{ check: 'rows', where: 'out3 = "Big"', limit: 2 }], ctx());
    const a = r.answers[0] as RowsAnswer;
    expect(a.matched).toBe(counts.Big);
    expect(a.rows).toHaveLength(2);
    for (const row of a.rows) expect((row.out as unknown[])[3]).toBe('Big');
    const first = pair.output.slice(1).findIndex((o) => o[3] === 'Big');
    expect(a.rows[0]!.in[0]).toBe(pair.input[first + 1]![0]);
  });
});

describe('masking: constants are unmasked first, every value that leaves is masked like the samples', () => {
  const key = new TextEncoder().encode('checks-test');
  const masked = (): Masker => createMasker(key);

  it('a rule written in the masked vocabulary matches; failing rows, expected and got are masked; numbers stay real', () => {
    const masker = masked();
    const [s, m, b] = ['Small', 'Medium', 'Big'].map((w) => masker.maskText(w)) as [string, string, string];
    expect(s).not.toBe('Small');
    const right = one({ check: 'test', column: 'Class', rule: `if(out2 < 1000, "${s}", if(out2 < 5000, "${m}", "${b}"))` }, { masker }) as TestAnswer;
    expect(right.matched).toBe(60);

    const r = answerChecks([{ check: 'test', column: 'Class', rule: `if(out2 < 2000, "${s}", if(out2 < 5000, "${m}", "${b}"))` }], ctx({ masker }));
    const wrong = r.answers[0] as TestAnswer;
    expect(wrong.failing.length).toBeGreaterThan(0);
    for (const f of wrong.failing) {
      expect(f.expected).toBe(m);
      expect(f.got).toBe(s);
      // the customer is masked like the samples (same masker, same key); the quantity stays real
      expect(['Dana Levi', 'Yossi Cohen', 'Noa Peretz', 'Omer Biton', 'Maya Golan'].map((c) => masker.maskText(c))).toContain(f.row.in[1]);
      expect(typeof f.row.in[2]).toBe('number');
    }
    const json = JSON.stringify(r.answers);
    for (const real of ['Dana Levi', 'Yossi Cohen', 'Noa Peretz', 'Omer Biton', 'Maya Golan', '"Small"', '"Medium"', '"Big"']) expect(json).not.toContain(real);
  });

  it('a where with a masked constant, and ranges / values / dependsOn values masked; thresholds real', () => {
    const masker = masked();
    const open = masker.maskText('Open');
    const n = pair.input.slice(1).filter((r) => r[4] === 'Open').length;
    const answers = answerChecks(
      [
        { check: 'rows', where: `in4 = "${open}"`, limit: 1 },
        { check: 'ranges', column: 'Class', by: 'Total' },
        { check: 'values', column: 'Customer' },
        { check: 'dependsOn', column: 'Class', on: ['Customer'] },
      ],
      ctx({ masker }),
    ).answers;
    expect((answers[0] as RowsAnswer).matched).toBe(n);
    const ranges = answers[1] as RangesAnswer;
    expect(ranges.clean && ranges.runs.map((x) => x.value)).toEqual(['Small', 'Medium', 'Big'].map((w) => masker.maskText(w)));
    expect(ranges.clean && typeof ranges.runs[0]!.from).toBe('number');
    const json = JSON.stringify(answers);
    for (const real of ['Dana', 'Yossi', 'Noa', 'Omer', 'Maya', '"Open"', '"Small"']) expect(json).not.toContain(real);
  });
});

describe('the row budget: rows shown count toward the learn\'s row limit', () => {
  const wrongRule: Check = { check: 'test', column: 'Class', rule: 'if(out2 < 2500, "Small", "Big")' };

  it('past the budget an answer gives counts only and says how many rows it withheld', () => {
    const r = answerChecks([wrongRule], ctx({ rowBudget: 1 }));
    const a = r.answers[0] as TestAnswer;
    expect(a.failing).toHaveLength(1);
    expect(a.withheld).toBe(2);
    expect(r.rowsShown).toHaveLength(1);
    const none = answerChecks([wrongRule], ctx({ rowBudget: 0 })).answers[0] as TestAnswer;
    expect(none).toMatchObject({ failing: [], withheld: 3 });
    expect(none.matched).toBe(a.matched);
  });

  it('a row already sent (a sample, an earlier check) is shown again without counting', () => {
    const first = answerChecks([wrongRule], ctx());
    const again = answerChecks([wrongRule], ctx({ rowBudget: 0, sent: new Set(first.rowsShown) }));
    expect((again.answers[0] as TestAnswer).failing).toHaveLength(3);
    expect(again.rowsShown).toEqual([]);
  });

  it('the budget is shared by the checks of a round', () => {
    const r = answerChecks([{ check: 'rows', where: 'in2 > 0', limit: 3 }, { check: 'rows', where: 'in2 > 0', limit: 5 }], ctx({ rowBudget: 4 }));
    expect((r.answers[0] as RowsAnswer).rows).toHaveLength(3);
    // the same 3 rows again, then one new, then withheld
    expect((r.answers[1] as RowsAnswer).rows).toHaveLength(4);
    expect((r.answers[1] as RowsAnswer).withheld).toBe(1);
    expect(r.rowsShown).toHaveLength(4);
  });

  it('withoutRows takes an answer\'s rows out and says they were withheld', () => {
    const a = answerChecks([wrongRule], ctx()).answers[0] as TestAnswer;
    expect(withoutRows(a)).toEqual({ rows: a.rows, matched: a.matched, failing: [], withheld: a.failing.length });
  });
});

describe('errors are answers, never a throw', () => {
  it('a formula that does not parse, an unknown column, a where that is no condition, a let id that clashes', () => {
    const answers = answerChecks(
      [
        { check: 'test', column: 'Class', rule: 'if(out2 < 1000, "Small"' },
        { check: 'test', column: 'Class', rule: 'amount * 2' },
        { check: 'values', column: 'Nope' },
        { check: 'values', column: 'Class', where: 'in2 + 1' },
        { check: 'values', column: 'Class', let: [{ id: 'in2', expr: 'in3' }] },
      ],
      ctx(),
    ).answers;
    expect(answers[0]).toEqual({ error: expect.stringMatching(/^rule: .*\(at \d+\)$/) });
    expect(answers[1]).toEqual({ error: expect.stringContaining('no column "amount"') });
    expect(answers[2]).toEqual({ error: expect.stringContaining('no column "Nope"') });
    expect(answers[3]).toEqual({ error: expect.stringContaining('where') });
    expect(answers[4]).toEqual({ error: expect.stringContaining('let in2') });
  });

  it('a type that does not fit names the formula', () => {
    expect(one({ check: 'test', column: 'Class', rule: 'in1 * 2' })).toEqual({ error: expect.stringMatching(/^rule: expected/) });
  });

  it('a check past the time budget answers an error; the next one gets its own budget', () => {
    let t = 0;
    const now = (): number => (t += 1500);
    const answers = answerChecks(
      [
        { check: 'values', column: 'Class' },
        { check: 'values', column: 'Class' },
      ],
      ctx({ now, timeBudgetMs: 2000 }),
    ).answers;
    expect(answers[0]).toEqual({ error: expect.stringContaining('ran out of time') });
    expect(answers[1]).toEqual({ error: expect.stringContaining('ran out of time') });
    const fast = answerChecks([{ check: 'values', column: 'Class' }], ctx({ now: () => 0 })).answers[0] as ValuesAnswer;
    expect(fast.distinct).toBe(3);
  });

  it('a failed check gives back the rows it took', () => {
    const r = answerChecks([{ check: 'test', column: 'Class', rule: 'nope(' }], ctx({ rowBudget: 1 }));
    expect(r.rowsShown).toEqual([]);
  });
});

describe('pure and deterministic', () => {
  it('the same checks give the same answers', () => {
    const checks: Check[] = [
      { check: 'test', column: 'Class', rule: 'if(out2 < 2000, "Small", "Big")' },
      { check: 'ranges', column: 'Class', by: 'Total' },
      { check: 'dependsOn', column: 'Class', on: ['Customer'] },
    ];
    const key = new TextEncoder().encode('same');
    expect(answerChecks(checks, ctx({ masker: createMasker(key) }))).toEqual(answerChecks(checks, ctx({ masker: createMasker(key) })));
  });
});
