// The overfitting guards where the browser judges (SPEC 9.2 layer 6, 21 v12 item 19): `learnFromExamples` runs the guards on every answer
// with every row of the example. A rule that copies rows of the example gets ONE repair per learn - a round of the loop carrying an `overfit`
// problem - and after it (or when no round can be made) the column is reported as unsupported by code, never counted as verified; and an
// answer that copies rows never beats the honest rule with the rows wrong. On the real eval cases discount-hand-edited (the learn-v8 answer
// `if(rowNumber() = 1, 0, ...)`) and fulfillment-external-column (its memorized warehouse list).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LearnPayload, LearnResult, RepairProblem, Rules } from '@formatai/shared';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { learnResultOf } from '../../src/learn/complete';
import type { LoopRound } from '../../src/learn/loop';
import { parseFormula } from '../../src/formula';

const CASES = path.resolve(__dirname, '../../../../eval/cases');
const KEPT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'keptRules.json'), 'utf8')) as { sources: string[]; rules: LearnResult }[];
const keptFrom = (source: string): LearnResult => KEPT.find((k) => k.sources.includes(source))!.rules;

function caseFiles(name: string): { input: { bytes: Uint8Array; name: string }; output: { bytes: Uint8Array; name: string }; reference: () => LearnResult } {
  const dir = path.join(CASES, name);
  const file = (base: string): { bytes: Uint8Array; name: string } => {
    const n = fs.readdirSync(dir).find((e) => e.startsWith(`${base}.`))!;
    return { bytes: new Uint8Array(fs.readFileSync(path.join(dir, n))), name: n };
  };
  const reference = (): LearnResult => learnResultOf(JSON.parse(fs.readFileSync(path.join(dir, 'reference.rules.json'), 'utf8')) as Rules);
  return { input: file('input'), output: file('output'), reference };
}

/** The discount case's reference rules (Discount = 10% of Amount) with the Discount formula replaced. */
function discountAnswer(reference: LearnResult, formula: string): LearnResult {
  const parsed = parseFormula(formula, { allowWindows: true });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { ...reference, transform: { ...reference.transform, computed: reference.transform.computed.map((c) => (c.id === 'discount' ? { ...c, expr: parsed.expr } : c)) } };
}

const BY_POSITION = 'if(rowNumber() = 1, 0, round(amount * 0.1, 2))';

interface Round {
  problems: RepairProblem[];
  round: LoopRound;
}

/** The AI step: `first` for the learn (with `overfitRepaired` when the API already made its repair), then `repairs` in order (the last one again). */
function aiStep(first: LearnResult, repairs: LearnResult[], firstRepaired = false) {
  const rounds: Round[] = [];
  return {
    rounds,
    callLearn: async (_payload: LearnPayload): Promise<LearnCallResult> => ({ rules: first, problems: [], calls: ['learn'], ...(firstRepaired ? { overfitRepaired: true } : {}) }),
    callRepair: async (_payload: LearnPayload, _previous: LearnResult, problems: RepairProblem[], round: LoopRound): Promise<LearnCallResult> => {
      rounds.push({ problems, round });
      return { rules: repairs[Math.min(rounds.length - 1, repairs.length - 1)]!, problems: [], calls: [`repair${rounds.length}`] };
    },
  };
}

async function run(name: string, ai: ReturnType<typeof aiStep>, withRepair = true) {
  const { input, output } = caseFiles(name);
  return learnFromExamples({ input, output, masking: false, tier: 'paid', callLearn: ai.callLearn, ...(withRepair ? { callRepair: ai.callRepair } : {}) });
}

describe('discount-hand-edited: the row-position answer learn-v8 wrote', () => {
  const reference = caseFiles('discount-hand-edited').reference();
  const position = discountAnswer(reference, BY_POSITION);

  it('the first round asks for the one repair (an overfit problem); an answer that still copies rows gets Discount reported as unsupported by code', async () => {
    const ai = aiStep(position, [position]);
    const result = await run('discount-hand-edited', ai);

    expect(ai.rounds[0]!.problems.filter((p) => p.kind === 'overfit')).toEqual([
      { kind: 'overfit', out: 3, message: expect.stringContaining('Column "Discount": this rule copies particular rows of the example') },
    ]);
    expect(ai.rounds[0]!.round.overfitRepaired).toBe(true);
    expect(result.rules?.output.columns.find((c) => c.header === 'Discount')?.from).toBeNull();
    expect(result.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(result.stages.verifiedFirstCall).toBe(false);
    expect(result.stages.verifiedAfterRepair).toBe(false);
    // never a second overfit problem in a later round
    expect(ai.rounds.slice(1).some((r) => r.problems.some((p) => p.kind === 'overfit'))).toBe(false);
  });

  it('the honest rule with the hand-edited rows wrong beats the copy: it is the answer kept', async () => {
    const ai = aiStep(position, [reference]);
    const result = await run('discount-hand-edited', ai);
    expect(result.rules?.transform.computed.find((c) => c.id === 'discount')?.expr).toEqual(reference.transform.computed.find((c) => c.id === 'discount')!.expr);
    expect(result.unsupported).toEqual([]);
    expect(result.verification?.verified).toBe(false); // the 3 hand-edited rows, shown to the user as they are
  });

  it('no round to repair it (no callRepair): the copy is never kept as a rule - Discount is reported as unsupported', async () => {
    const result = await run('discount-hand-edited', aiStep(position, []), false);
    expect(result.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(result.stages.verifiedAfterRepair).toBe(false);
  });

  it('a learn whose repair the API already made (overfitRepaired) falls back at once, and asks no round about it', async () => {
    const ai = aiStep(position, [position], true);
    const result = await run('discount-hand-edited', ai);
    expect(result.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(ai.rounds.flatMap((r) => r.problems).some((p) => p.kind === 'overfit')).toBe(false);
  });
});

describe('discount-hand-edited: the lookup keyed on the amount learn-v8.1 wrote (its first real learn, 2026-10-05)', () => {
  const v81 = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'learnV81Discount.json'), 'utf8')) as { rules: LearnResult }).rules;
  const reference = caseFiles('discount-hand-edited').reference();

  it('it matches every row, yet it is not verified: the round asks for a rule that holds for any row, and the honest rule is kept', async () => {
    const ai = aiStep(v81, [reference]);
    const result = await run('discount-hand-edited', ai);
    expect(ai.rounds[0]!.problems.filter((p) => p.kind === 'overfit').map((p) => p.message)).toEqual([expect.stringContaining('it looks values up by an amount')]);
    expect(result.stages.verifiedFirstCall).toBe(false);
    expect(result.rules?.transform.tables ?? []).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('the same lookup again: Discount "needs your input", with no table of the example\'s amounts left in the rules', async () => {
    const result = await run('discount-hand-edited', aiStep(v81, [v81]));
    expect(result.unsupported).toEqual([{ outputColumn: 'Discount', reasonCode: 'overfit' }]);
    expect(result.rules?.transform.tables ?? []).toEqual([]);
  });
});

describe('fulfillment-external-column: the memorized warehouse list learn-v8 wrote (completion mode, kept as a plain answer here)', () => {
  const caseList = keptFrom('cmp-learn-v8-complete/fulfillment-external-column.complete');
  const honest = keptFrom('cmp-learn-v7/fulfillment-external-column.full');

  it('it matches every row, yet it is not verified: the round asks for a rule that holds for any row, and the honest externalData answer is kept', async () => {
    const ai = aiStep(caseList, [honest]);
    const result = await run('fulfillment-external-column', ai);
    expect(ai.rounds).toHaveLength(1);
    expect(ai.rounds[0]!.problems.map((p) => p.kind)).toEqual(['overfit']);
    expect(result.stages.verifiedFirstCall).toBe(false);
    expect(result.unsupported).toEqual([{ outputColumn: 'Assigned Warehouse', reasonCode: 'externalData' }]);
    expect(result.stages.verifiedAfterRepair).toBe(true);
  });

  it('the same list again after the repair: "needs your input" (reason overfit), as honest as learn-v7\'s answer', async () => {
    const result = await run('fulfillment-external-column', aiStep(caseList, [caseList]));
    expect(result.unsupported).toEqual([{ outputColumn: 'Assigned Warehouse', reasonCode: 'overfit' }]);
    expect(result.rules?.transform.computed.map((c) => c.id)).not.toContain('assignedWarehouse');
    // every column that has a rule matches the example
    expect(result.verification?.verified).toBe(true);
  });
});

describe('a class written out ID by ID (owner amendment, 2026-10-06: gpt-5\'s escalation on the owner\'s file; synthetic IDs here)', () => {
  // 48 people, Qty x Price; Class by that total (Small below 1,000, Medium below 5,000, else Big) - nothing in the input says the total.
  const N = 48;
  const qty = (i: number): number => 1 + ((i * 7) % 20);
  const price = (i: number): number => 50 + ((i * 37) % 400);
  const classOf = (i: number): string => (qty(i) * price(i) < 1000 ? 'Small' : qty(i) * price(i) < 5000 ? 'Medium' : 'Big');
  const person = (i: number): string => `P-${100 + i}`;
  const csv = (lines: string[]): { bytes: Uint8Array; name: string } => ({ bytes: new TextEncoder().encode(`${lines.join('\n')}\n`), name: 'f.csv' });
  const rows = Array.from({ length: N }, (_, i) => i);
  const input = csv(['Person,Qty,Price', ...rows.map((i) => `${person(i)},${qty(i)},${price(i)}`)]);
  const output = csv(['Person,Class', ...rows.map((i) => `${person(i)},${classOf(i)}`)]);
  const listOf = (c: string): string => rows.filter((i) => classOf(i) === c).map((i) => `person = "${person(i)}"`).join(', ');
  const parsed = parseFormula(`switch(or(${listOf('Small')}), "Small", or(${listOf('Big')}), "Big", qty = 99, "Big", oneOf(qty, 97, 98), "Small", "Medium")`);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const memorized: LearnResult = {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'person', header: 'Person', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'price', header: 'Price', type: 'integer' },
      ],
    },
    transform: { computed: [{ id: 'class', type: 'text', expr: parsed.expr }], valueMaps: [], sort: [] },
    output: {
      file: { type: 'csv', delimiter: ',', encoding: 'utf8', quote: 'minimal', header: true },
      sheetName: 'f',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [{ header: 'Person', from: 'person' }, { header: 'Class', from: 'class' }],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };

  it('is found on every row (its or-lists pick many rows as cases, one each as atoms): one repair, then "needs your input" - and the IDs are gone', async () => {
    expect(rows.filter((i) => classOf(i) !== 'Medium').length).toBeGreaterThanOrEqual(12);
    const ai = aiStep(memorized, [memorized]);
    const result = await learnFromExamples({ input, output, masking: false, tier: 'paid', callLearn: ai.callLearn, callRepair: ai.callRepair });
    expect(result.path).toBe('llm');
    expect(ai.rounds[0]!.problems.filter((p) => p.kind === 'overfit')).toEqual([
      { kind: 'overfit', out: 1, message: expect.stringContaining('Column "Class": this rule copies particular rows of the example (it is a list of 4 cases whose conditions name') },
    ]);
    expect(ai.rounds.slice(1).some((r) => r.problems.some((p) => p.kind === 'overfit'))).toBe(false);
    expect(result.unsupported).toEqual([{ outputColumn: 'Class', reasonCode: 'overfit' }]);
    expect(result.rules?.transform.computed).toEqual([]);
    expect(JSON.stringify(result.rules)).not.toContain('P-1');
    expect(result.verification?.verified).toBe(true);
  });
});
