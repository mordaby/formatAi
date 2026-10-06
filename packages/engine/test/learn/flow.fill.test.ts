// learnFromExamples fills the data parameters of each answer from every row (`fillParams`, learning-loop proposal 7.1) AFTER unmasking:
// the AI step writes a lookup table in masked words with the few entries its samples showed; code completes it with the real values of
// every row; the learn result says what was filled (kinds and counts); and a repair round sends the answer as the AI wrote it - nothing
// code filled is ever in a request.
import type { Expr, LearnPayload, LearnResult, PayloadCell, RepairProblem } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import type { LoopRound } from '../../src/learn/loop';
import type { V } from './analyze/helpers';
import { xlsxBytesOf } from './v5fixtures';

/** 30 branches sold in stores and online (online rows show "Online"); B07's store rows disagree (one is hand-edited). */
function branchPair(): { input: V[][]; output: V[][]; names: string[] } {
  const input: V[][] = [['Sale', 'Code', 'Channel']];
  const output: V[][] = [['Sale', 'Branch']];
  const names: string[] = [];
  let i = 0;
  for (let b = 1; b <= 30; b++) {
    const code = `B${String(b).padStart(2, '0')}`;
    const name = `Branch${b} ${b % 2 ? 'Northside' : 'Southside'}`;
    names.push(name);
    for (const channel of ['Store', 'Store', 'Online']) {
      i++;
      input.push([`S${1000 + i}`, code, channel]);
      output.push([`S${1000 + i}`, channel === 'Online' ? 'Online' : code === 'B07' && i % 2 === 0 ? 'Edited by hand' : name]);
    }
  }
  return { input, output, names };
}

/** The AI step's answer, in the payload's own (masked) words: a lookup with the pairs its samples show. */
function answerFrom(payload: LearnPayload): LearnResult {
  const rows = payload.samples.map((s) => ({ in: s.in as PayloadCell[], out: s.out as PayloadCell[] }));
  const online = rows.find((r) => r.in[2] === r.out[1])!.in[2] as string;
  const pairs = new Map<string, string>();
  for (const r of rows) if (r.in[2] !== online) pairs.set(String(r.in[1]), String(r.out[1]));
  const expr: Expr = { op: 'if', cond: { op: 'eq', args: [{ col: 'channel' }, { const: online }] }, then: { const: online }, else: { op: 'lookup', table: 'branches', key: { col: 'code' }, return: 'name', onMissing: 'flag' } };
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'sale', header: 'Sale', type: 'idLike' }, { id: 'code', header: 'Code', type: 'text' }, { id: 'channel', header: 'Channel', type: 'text' }] },
    transform: { computed: [{ id: 'branch', type: 'text', expr }], valueMaps: [], sort: [], tables: [{ name: 'branches', columns: ['code', 'name'], rows: [...pairs] }] },
    output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Sale', from: 'sale' }, { header: 'Branch', from: 'branch' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

describe('learnFromExamples: code fills the data parameters, after unmasking', () => {
  it('the masked answer\'s few entries become the whole table of real values; nothing filled is sent in a round', async () => {
    const p = branchPair();
    const sent: { payload: LearnPayload; previous: LearnResult; problems: RepairProblem[]; round: LoopRound }[] = [];
    let first: LearnResult | undefined;
    const r = await learnFromExamples({
      input: { bytes: await xlsxBytesOf(p.input), name: 'in.xlsx' },
      output: { bytes: await xlsxBytesOf(p.output), name: 'out.xlsx' },
      masking: true,
      key: new TextEncoder().encode('fill-after-unmask'),
      tier: 'paid',
      callLearn: async (payload): Promise<LearnCallResult> => {
        first = answerFrom(payload);
        return { rules: first, problems: [], calls: [] };
      },
      callRepair: async (payload, previous, problems, round): Promise<LearnCallResult> => {
        sent.push({ payload, previous, problems, round });
        return { rules: null, problems: [], calls: [] };
      },
    });
    expect(r.path).toBe('llm');
    const aiEntries = first!.transform.tables![0]!.rows.length;
    expect(aiEntries).toBeLessThan(29);
    // (the samples may show B07, hand-edited row and all: the AI's own entries are never changed)
    const aiHasB07 = r.rules!.transform.tables![0]!.rows.slice(0, aiEntries).some((row) => row[0] === 'B07');

    // filled with REAL values from every row: every branch but B07, whose rows disagree
    const table = r.rules!.transform.tables![0]!;
    expect(table.rows).toHaveLength(aiHasB07 ? 30 : 29);
    expect(table.rows.slice(aiEntries).find((row) => row[0] === 'B07')).toBeUndefined();
    expect(table.rows.find((row) => row[0] === 'B12')).toEqual(['B12', 'Branch12 Southside']);
    expect(r.filled).toEqual({ filled: [{ kind: 'lookup', count: table.rows.length - aiEntries }], checks: 0 });
    // B07's store rows are what is still wrong: the loop made its round with them
    expect(r.verification?.mismatches).toHaveLength(aiHasB07 ? 1 : 2);
    // ... and then (docs/proposals/saved-format-contents.md section 4) the one round for the list it kept: 29 or 30 branches by code, more
    // than a small vocabulary - its problem names the column, the count and the key, never a value
    expect(sent).toHaveLength(2);
    expect(sent[1]!.round).toMatchObject({ round: 2, list: true, newRows: 0 });
    expect(sent[1]!.problems).toEqual([
      {
        kind: 'list',
        out: 1,
        message: `Column "Branch" is a list of ${table.rows.length} fixed values, one per Code. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each Code itself, or comes from outside the file - keep the list.`,
      },
    ]);
    expect(r.listRetry).toEqual({ columns: ['Branch'], calls: 1, checkRounds: 0, outcome: 'noAnswer' });
    expect(r.loop?.rounds).toBe(2);

    // the round sent the answer as the AI wrote it (its masked entries only), and no real name anywhere
    expect(sent[0]!.previous.transform.tables![0]!.rows).toHaveLength(aiEntries);
    const request = JSON.stringify(sent);
    for (const name of p.names) for (const word of name.split(' ')) expect(request).not.toContain(word);
  });
});
