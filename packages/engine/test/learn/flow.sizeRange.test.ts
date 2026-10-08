// The size range of a number column is written at the END of a learn (SPEC 8.15, owner decision 2026-10-08): from the example input, whichever path made
// the rules, and never part of anything the AI step is sent. Fakes only - no model is called.
import type { Format, LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { writeXlsx } from '../../src/io/writeXlsx';
import { completePayloadOf } from '../../src/learn/complete';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { formatOf } from '../../src/registry';
import type { OutRow, OutputSheet } from '../../src/types';

async function xlsxBytes(headers: string[], rows: (string | number | boolean | null)[][]): Promise<Uint8Array> {
  const sheet: OutputSheet = {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: headers.map((h) => ({ header: h })),
    rows: [{ kind: 'header', cells: headers.map((h) => ({ v: h })) } as OutRow, ...rows.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v })) }))],
    merges: [],
  };
  return writeXlsx(sheet);
}

const ok = <Call,>(rules: LearnResult | null, calls: Call[] = []): LearnCallResult<Call> => ({ rules, problems: [], calls });
const rangeOf = (r: LearnResult | null, header: string) => r?.input.columns.find((c) => c.header === header)?.range;

const NAMES = ['Dana', 'Yossi', 'Noa', 'Omer', 'Maya'];
const THOUSANDS = [1200, 3400, 25_000, 41_000, 8800];

describe('learnFromExamples writes the size of the number columns it learned', () => {
  it('the fast path: from the example input', async () => {
    const input = await xlsxBytes(['Name', 'Amount'], NAMES.map((n, i) => [n, THOUSANDS[i]!]));
    const output = await xlsxBytes(['Amount', 'Name'], NAMES.map((n, i) => [THOUSANDS[i]!, n]));
    const result = await learnFromExamples({
      input: { bytes: input, name: 'in.xlsx' },
      output: { bytes: output, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      callLearn: async () => ok(null),
    });
    expect(result.path).toBe('local');
    expect(rangeOf(result.rules, 'Amount')).toEqual({ lo: 3, hi: 4 });
    expect(rangeOf(result.rules, 'Name')).toBeUndefined();
  });

  it('too few non-zero values in a column: no range (nothing is claimed from so little)', async () => {
    const amounts = [0, 0, 5000, 0, 0];
    const input = await xlsxBytes(['Name', 'Amount'], NAMES.map((n, i) => [n, amounts[i]!]));
    const output = await xlsxBytes(['Amount', 'Name'], NAMES.map((n, i) => [amounts[i]!, n]));
    const result = await learnFromExamples({
      input: { bytes: input, name: 'in.xlsx' },
      output: { bytes: output, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      callLearn: async () => ok(null),
    });
    expect(result.rules).not.toBeNull();
    expect(result.rules!.input.columns.some((c) => c.range !== undefined)).toBe(false);
  });

  it('the AI path with a repair round: the rules the AI step is sent back carry no range, and the kept answer has it at the end', async () => {
    const input = await xlsxBytes(['Name', 'Amount'], NAMES.map((n, i) => [n, THOUSANDS[i]!]));
    const output = await xlsxBytes(['Amount', 'Name'], NAMES.map((n, i) => [THOUSANDS[i]!, n]));
    const wrong: LearnResult = {
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'name', header: 'Name', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
      transform: { computed: [], valueMaps: [], sort: [] },
      // "Name" wrongly copied from the amount: the full verification fails, so the loop makes a repair round.
      output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Amount', from: 'amount' }, { header: 'Name', from: 'amount' }] },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const fixed: LearnResult = { ...wrong, output: { ...wrong.output, columns: [{ header: 'Amount', from: 'amount' }, { header: 'Name', from: 'name' }] } };
    const target: Format = formatOf(fixed);

    const sent: string[] = [];
    const result = await learnFromExamples({
      input: { bytes: input, name: 'in.xlsx' },
      output: { bytes: output, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      target,
      callLearn: async (payload: LearnPayload) => {
        sent.push(JSON.stringify(payload));
        return ok(wrong, ['learn']);
      },
      callRepair: async (payload, previousRules) => {
        sent.push(JSON.stringify(payload), JSON.stringify(previousRules));
        return ok(fixed, ['repair']);
      },
    });

    expect(result.calls).toEqual(['learn', 'repair']);
    expect(result.stages.browserRepairUsed).toBe(true);
    // Nothing sent to the AI step ever had a range: it is computed after the last round.
    expect(sent.map((s) => s.includes('"lo"'))).toEqual([false, false, false]);
    expect(rangeOf(result.rules, 'Amount')).toEqual({ lo: 3, hi: 4 });
    expect(rangeOf(result.rules, 'Name')).toBeUndefined();
  });
});

describe('the AI step is never sent a size range', () => {
  it("the rules a completion carries (\"Finish with AI\" after a free learn that wrote them) go out without it", () => {
    const fixed: LearnResult = {
      schemaVersion: 1,
      input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'amount', header: 'Amount', type: 'decimal', range: { lo: 3, hi: 4 } }] },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Amount', from: 'amount' }] },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const payload = completePayloadOf({ fixedRules: fixed, columns: [], parts: [] });
    expect(JSON.stringify(payload)).not.toContain('"lo"');
    expect(JSON.stringify(payload)).toContain('Amount');
    expect(fixed.input.columns[0]!.range).toEqual({ lo: 3, hi: 4 }); // the user's rules are untouched
  });
});
