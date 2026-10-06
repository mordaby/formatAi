// Logic first (docs/proposals/saved-format-contents.md section 4; `learnFromExamples`): when the answer the loop kept has a list column, the
// flow sends ONE automatic repair round for it, naming the column (masked vocabulary only, no value). Logic found -> the list is gone;
// the list kept -> it stays for the conversion and is asked about at Save; a worse answer is not taken; one round per learn, within the
// loop's caps; with learn-v9 the AI step may check its idea with code first.
import { describe, expect, it } from 'vitest';
import type { Check, CheckRound, Expr, LearnPayload, LearnResult, RepairProblem } from '@formatai/shared';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import type { LoopRound } from '../../src/learn/loop';
import { parseFormula } from '../../src/formula';
import type { V } from './analyze/helpers';
import { xlsxBytesOf } from './v5fixtures';

const f = (text: string): Expr => {
  const parsed = parseFormula(text, { allowWindows: true });
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return parsed.expr;
};

// 30 products, 2 orders each; Size is a band on the price (Small below 100) - logic the AI may miss and write as a list by product instead.
const price = (p: number): number => 20 + ((p * 37) % 160);
const size = (p: number): string => (price(p) < 100 ? 'Small' : 'Big');
function pair(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Order', 'Product', 'Price']];
  const output: V[][] = [['Order', 'Product', 'Size']];
  let n = 0;
  for (let p = 0; p < 30; p++) {
    for (let t = 0; t < 2; t++) {
      n++;
      input.push([`ORD-${1000 + n}`, `P-${String(p + 1).padStart(3, '0')}`, price(p)]);
      output.push([`ORD-${1000 + n}`, `P-${String(p + 1).padStart(3, '0')}`, size(p)]);
    }
  }
  return { input, output };
}

function answer(sizeExpr: string): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text' },
        { id: 'product', header: 'Product', type: 'text' },
        { id: 'price', header: 'Price', type: 'integer' },
      ],
    },
    transform: { computed: [{ id: 'size', type: 'text', expr: f(sizeExpr) }], valueMaps: [], sort: [], tables: [{ name: 'sizes', columns: ['product', 'size'], rows: [] }] },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Product', from: 'product' },
        { header: 'Size', from: 'size' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** The list: Size looked up by product, the table left for code to fill from every row (30 entries). */
const LIST = answer('lookup("sizes", product, "size")');
/** The logic behind it. */
const LOGIC = answer('if(price < 100, "Small", "Big")');
/** A wrong rule: one size for every product (code's fill would settle a misplaced cut-off, so that would be no worse). */
const WRONG = answer('"Big"');

interface Sent {
  previous: LearnResult;
  problems: RepairProblem[];
  round: LoopRound;
}

async function run(repairs: LearnCallResult[], opts: { masking?: boolean } = {}): Promise<{ result: Awaited<ReturnType<typeof learnFromExamples>>; sent: Sent[] }> {
  const p = pair();
  const sent: Sent[] = [];
  const result = await learnFromExamples({
    input: { bytes: await xlsxBytesOf(p.input), name: 'in.xlsx' },
    output: { bytes: await xlsxBytesOf(p.output), name: 'out.xlsx' },
    masking: opts.masking ?? false,
    ...(opts.masking ? { key: new TextEncoder().encode('list-retry') } : {}),
    tier: 'paid',
    callLearn: async (): Promise<LearnCallResult> => ({ rules: LIST, problems: [], calls: ['learn'] }),
    callRepair: async (_payload: LearnPayload, previous, problems, round): Promise<LearnCallResult> => {
      sent.push({ previous, problems, round });
      return repairs.shift() ?? { rules: null, problems: [], calls: ['nothing'] };
    },
  });
  return { result, sent };
}

const MESSAGE =
  'Column "Size" is a list of 30 fixed values, one per Product. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each Product itself, or comes from outside the file - keep the list.';

describe('the one round for a list column', () => {
  it('logic found: the answer without the list replaces it, verified - nothing to ask at Save', async () => {
    const { result, sent } = await run([{ rules: LOGIC, problems: [], calls: ['repair'] }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.problems).toEqual([{ kind: 'list', out: 2, message: MESSAGE }]);
    // A round of the loop (the first answer verified: round 1 of 3), no new row, the answer as the AI wrote it (nothing filled is sent).
    expect(sent[0]!.round).toMatchObject({ round: 1, maxRounds: 3, newRows: 0, list: true });
    expect(sent[0]!.previous.transform.tables?.[0]?.rows).toEqual([]);
    expect(result.listRetry).toEqual({ columns: ['Size'], calls: 1, checkRounds: 0, outcome: 'logic' });
    expect(result.rules?.transform.computed[0]?.expr).toEqual(LOGIC.transform.computed[0]!.expr);
    expect(result.verification?.verified).toBe(true);
    expect(result.oneTimers).toBeUndefined();
    expect(result.stages).toMatchObject({ verifiedFirstCall: true, browserRepairUsed: true, verifiedAfterRepair: true });
    expect(result.loop).toEqual({ rounds: 1, rowsSent: 0, end: 'verified' });
    expect(result.calls).toEqual(['learn', 'repair']);
  });

  it('the list kept: it stays for the conversion and is asked about at Save', async () => {
    const { result, sent } = await run([{ rules: LIST, problems: [], calls: ['repair'] }]);
    expect(sent).toHaveLength(1);
    expect(result.listRetry).toEqual({ columns: ['Size'], calls: 1, checkRounds: 0, outcome: 'kept' });
    expect(result.verification?.verified).toBe(true);
    expect(result.rules?.transform.tables?.[0]?.rows).toHaveLength(30);
    expect(result.oneTimers?.questions).toEqual([
      { kind: 'copiedList', out: 2, header: 'Size', keyColumn: 'Product', entries: 30, list: { kind: 'lookup', computed: 'size', table: 'sizes' } },
    ]);
  });

  it('a worse answer is not taken: the list stays (and is asked about), one round only', async () => {
    const { result, sent } = await run([{ rules: WRONG, problems: [], calls: ['repair'] }, { rules: LOGIC, problems: [], calls: ['repair'] }]);
    expect(sent).toHaveLength(1);
    expect(result.listRetry?.outcome).toBe('worse');
    expect(result.verification?.verified).toBe(true);
    expect(result.oneTimers?.questions.map((q) => q.kind)).toEqual(['copiedList']);
  });

  it('no usable rules back: the list stays; the learn makes no second round for it', async () => {
    const { result, sent } = await run([]);
    expect(sent).toHaveLength(1);
    expect(result.listRetry?.outcome).toBe('noAnswer');
    expect(result.oneTimers?.questions.map((q) => q.kind)).toEqual(['copiedList']);
  });

  it('masking on: the round says the column, the count and the key column, never a value', async () => {
    const { sent } = await run([{ rules: LIST, problems: [], calls: ['repair'] }], { masking: true });
    expect(sent[0]!.problems).toEqual([{ kind: 'list', out: 2, message: MESSAGE }]);
    const text = JSON.stringify(sent[0]!.problems);
    expect(text).not.toContain('P-0');
    expect(text).not.toContain('Small');
  });

  it('no list, no round: the logic answer verified first is the learn', async () => {
    const p = pair();
    let repairs = 0;
    const result = await learnFromExamples({
      input: { bytes: await xlsxBytesOf(p.input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(p.output), name: 'out.xlsx' },
      masking: false,
      tier: 'paid',
      callLearn: async (): Promise<LearnCallResult> => ({ rules: LOGIC, problems: [], calls: [] }),
      callRepair: async (): Promise<LearnCallResult> => {
        repairs++;
        return { rules: null, problems: [], calls: [] };
      },
    });
    expect(repairs).toBe(0);
    expect(result.listRetry).toBeUndefined();
    expect(result.stages.browserRepairUsed).toBe(false);
  });

  it('learn-v9: the AI step checks its idea with code first (a ranges check), then answers with the logic', async () => {
    const ranges: Check = { check: 'ranges', column: 'Size', by: 'in2' };
    const { result, sent } = await run([
      { rules: null, checks: [ranges], problems: [], calls: ['check'] },
      { rules: LOGIC, problems: [], calls: ['repair'] },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.round.checks).toBeUndefined();
    // The second call is the same round with the round of checks answered on every row: two clean runs by the price, the cut at 100.
    expect(sent[1]!.round).toMatchObject({ round: 2, list: true });
    const rounds = sent[1]!.round.checks as CheckRound[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.checks).toEqual([ranges]);
    expect(rounds[0]!.answers[0]).toMatchObject({ clean: true });
    expect(sent[1]!.problems).toEqual(sent[0]!.problems);
    expect(result.listRetry).toEqual({ columns: ['Size'], calls: 2, checkRounds: 1, outcome: 'logic' });
    expect(result.loop?.rounds).toBe(2);
    expect(result.checks).toBeUndefined();
  });

  it('within the loop\'s caps: checks past the last round left are never answered (the call is the round\'s last)', async () => {
    const ranges: Check = { check: 'ranges', column: 'Size', by: 'in2' };
    const asks = (): LearnCallResult => ({ rules: null, checks: [ranges], problems: [], calls: ['check'] });
    const { result, sent } = await run([asks(), asks(), asks(), asks()]);
    // round 1, then two more calls with checks: 3 calls = the loop's 3 rounds; the last answer still asks checks - no rules, the list stays.
    expect(sent.map((s) => s.round.round)).toEqual([1, 2, 3]);
    expect(result.listRetry).toEqual({ columns: ['Size'], calls: 3, checkRounds: 2, outcome: 'noAnswer' });
    expect(result.oneTimers?.questions.map((q) => q.kind)).toEqual(['copiedList']);
  });
});
