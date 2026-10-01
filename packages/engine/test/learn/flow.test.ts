// learnFromExamples (SPEC 5 flow A/A2): the end-to-end orchestration, with a fake
// injected callLearn/callRepair standing in for the real API. Exercises the sequence
// pre-flight -> fast path -> payload -> learn -> unmask -> verify -> (repair) exactly
// as SPEC 5 describes, without any real network or LLM.
import { describe, expect, it } from 'vitest';
import type { Format, LearnPayload, LearnResult } from '@formatai/shared';
import { formatOf } from '../../src/registry';
import { learnFromExamples, type LearnCallResult } from '../../src/learn/flow';
import { createMasker } from '../../src/learn/mask';
import { writeXlsx } from '../../src/io/writeXlsx';
import type { OutRow, OutputSheet } from '../../src/types';

async function xlsxBytes(headers: string[], rows: (string | number | boolean | null)[][]): Promise<Uint8Array> {
  const sheet: OutputSheet = {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: headers.map((h) => ({ header: h })),
    rows: [
      { kind: 'header', cells: headers.map((h) => ({ v: h })) } as OutRow,
      ...rows.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v })) })),
    ],
    merges: [],
  };
  return writeXlsx(sheet);
}

function ok<Call>(rules: LearnResult | null, calls: Call[] = []): LearnCallResult<Call> {
  return { rules, problems: [], calls };
}

describe('learnFromExamples: the local fast path', () => {
  it('verifies locally with no LLM call, when the input is simple enough', async () => {
    const inputBytes = await xlsxBytes(
      ['Customer ID', 'Customer Name'],
      [
        [1, 'Dana'],
        [2, 'Yossi'],
        [3, 'Noa'],
        [4, 'Omer'],
        [5, 'Maya'],
      ],
    );
    const outputBytes = await xlsxBytes(
      ['Name', 'ID'],
      [
        ['Dana', 1],
        ['Yossi', 2],
        ['Noa', 3],
        ['Omer', 4],
        ['Maya', 5],
      ],
    );

    let called = false;
    const result = await learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      callLearn: async () => {
        called = true;
        return ok(null);
      },
    });

    expect(called).toBe(false);
    expect(result.path).toBe('local');
    expect(result.calls).toEqual([]);
    expect(result.verification?.verified).toBe(true);
    expect(result.stages).toMatchObject({ fastPathTried: true, fastPathSucceeded: true, llmCalled: false, verifiedAfterRepair: true });
    expect(result.rules?.output.columns.map((c) => c.header)).toEqual(['Name', 'ID']);
  });
});

describe('learnFromExamples: pre-flight blocks', () => {
  it('blocks on identical files, with no LLM call', async () => {
    const bytes = await xlsxBytes(
      ['ID', 'Name'],
      [
        [1, 'Dana'],
        [2, 'Yossi'],
      ],
    );
    const result = await learnFromExamples({
      input: { bytes, name: 'in.xlsx' },
      output: { bytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      callLearn: async () => ok(null),
    });
    expect(result.path).toBe('blocked');
    expect(result.preflight.status).toBe('block');
    expect(result.rules).toBeNull();
    expect(result.calls).toEqual([]);
  });
});

describe('learnFromExamples: rows that could not be aligned', () => {
  async function build(tryAnyway: boolean) {
    const inputBytes = await xlsxBytes(
      ['ID', 'Name'],
      [
        [1, 'Dana'],
        [2, 'Yossi'],
        [3, 'Noa'],
        [4, 'Omer'],
        [5, 'Maya'],
        [6, 'Tal'],
      ],
    );
    // Row with ID 99 has no matching input row at all.
    const outputBytes = await xlsxBytes(
      ['Name', 'ID'],
      [
        ['Dana', 1],
        ['Yossi', 2],
        ['Noa', 3],
        ['Omer', 4],
        ['Maya', 5],
        ['Ghost', 99],
      ],
    );
    return learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      tryAnyway,
      callLearn: async () => ok(null),
    });
  }

  it('stops without tryAnyway', async () => {
    const result = await build(false);
    expect(result.preflight.status).toBe('warn');
    expect(result.preflight.issues.some((i) => i.code === 'rowsNotAligned')).toBe(true);
    expect(result.path).toBe('blocked');
  });

  it('continues with tryAnyway (counts as a learn, per SPEC 6.4)', async () => {
    const result = await build(true);
    expect(result.path).not.toBe('blocked');
  });
});

describe('learnFromExamples: attach mode skips the fast path', () => {
  it('goes through callLearn even for a case the fast path could otherwise solve', async () => {
    // IDs deliberately not additive (101 + 102 != 103): a sequence like 1,2,3 would
    // make the input's last row look like a footer ("contains sums of the column
    // above", SPEC 6.1) and get dropped from the data rows.
    const inputBytes = await xlsxBytes(
      ['Customer ID', 'Customer Name'],
      [
        [101, 'Dana'],
        [102, 'Yossi'],
        [103, 'Noa'],
      ],
    );
    const outputBytes = await xlsxBytes(
      ['Name', 'ID'],
      [
        ['Dana', 101],
        ['Yossi', 102],
        ['Noa', 103],
      ],
    );

    const answer: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'Customer ID', type: 'integer' },
          { id: 'name', header: 'Customer Name', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Name', from: 'name' },
          { header: 'ID', from: 'id' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const target: Format = formatOf(answer);

    let receivedTarget: unknown;
    const result = await learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      target,
      callLearn: async (payload: LearnPayload) => {
        receivedTarget = payload.target;
        return ok(answer);
      },
    });

    expect(receivedTarget).toBeDefined();
    expect(result.path).toBe('llm');
    expect(result.stages.fastPathTried).toBe(false);
    expect(result.stages.verifiedFirstCall).toBe(true);
    expect(result.verification?.verified).toBe(true);
  });
});

describe('learnFromExamples: masking, with a value-map hint round-tripped through the fake vocabulary', () => {
  it('unmasks the LLM-returned constants back to the real words before verifying', async () => {
    // IDs deliberately not additive (SPEC 6.1 footer heuristic - see the attach-mode
    // test above for why 1,2,3,... would misfire).
    const rows: [number, string][] = [
      [101, 'Alpha'],
      [102, 'Beta'],
      [103, 'Alpha'],
      [104, 'Beta'],
      [105, 'Alpha'],
      [106, 'Beta'],
    ];
    const inputBytes = await xlsxBytes(['ID', 'Category'], rows);
    const outputBytes = await xlsxBytes(
      ['ID', 'Code'],
      // Codes unrelated to the category text itself (not its first letter), so pair
      // analysis reports this as a valueMap relation, not a substr coincidence.
      rows.map(([id, cat]) => [id, cat === 'Alpha' ? 'P' : 'Q']),
    );

    const answerTemplate: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'ID', type: 'integer' },
          { id: 'category', header: 'Category', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'ID', from: 'id' },
          { header: 'Code', from: 'category' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const target: Format = formatOf(answerTemplate);
    const key = new TextEncoder().encode('flow-test-key');

    let sawMaskedPair = false;
    const result = await learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: true,
      key,
      tier: 'registered',
      target,
      callLearn: async (payload: LearnPayload) => {
        expect(payload.masking).toBe(true);
        const hint = payload.hints.find((h) => 'rel' in h && h.rel === 'valueMap') as { pairs: [string, string][] } | undefined;
        expect(hint).toBeDefined();
        sawMaskedPair = hint!.pairs.some(([from]) => from !== 'Alpha' && from !== 'Beta');
        const answer: LearnResult = {
          ...answerTemplate,
          transform: { ...answerTemplate.transform, valueMaps: [{ column: 'category', map: Object.fromEntries(hint!.pairs), onMissing: 'flag' }] },
        };
        return ok(answer);
      },
    });

    expect(sawMaskedPair).toBe(true);
    expect(result.path).toBe('llm');
    expect(result.stages.verifiedFirstCall).toBe(true);
    // Saved/shown rules are unmasked: the real words, never the fake ones.
    expect(result.rules?.transform.valueMaps[0]?.map).toEqual({ Alpha: 'P', Beta: 'Q' });
  });
});

describe('learnFromExamples: browser-triggered repair (SPEC 5 A step 6 / 9.3)', () => {
  it('re-verifies after one repair call and reports it in stages', async () => {
    const inputBytes = await xlsxBytes(
      ['Customer ID', 'Customer Name'],
      [
        [101, 'Dana'],
        [102, 'Yossi'],
        [103, 'Noa'],
      ],
    );
    const outputBytes = await xlsxBytes(
      ['Name', 'ID'],
      [
        ['Dana', 101],
        ['Yossi', 102],
        ['Noa', 103],
      ],
    );

    const wrong: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'Customer ID', type: 'integer' },
          { id: 'name', header: 'Customer Name', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        // "Name" wrongly copied from the ID (a column that has a rule is compared with the example; one reported as unsupported is not - see flow.unsupported.test.ts).
        columns: [
          { header: 'Name', from: 'id' },
          { header: 'ID', from: 'id' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const fixed: LearnResult = { ...wrong, output: { ...wrong.output, columns: [{ header: 'Name', from: 'name' }, { header: 'ID', from: 'id' }] }, unsupported: [] };
    const target: Format = formatOf(fixed);

    let repairSeenPreviousRules: LearnResult | undefined;
    const result = await learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      target,
      callLearn: async () => ok(wrong, ['learn-call']),
      callRepair: async (_payload, previousRules) => {
        repairSeenPreviousRules = previousRules;
        return ok(fixed, ['repair-call']);
      },
    });

    expect(repairSeenPreviousRules).toEqual(wrong);
    expect(result.stages.browserRepairUsed).toBe(true);
    expect(result.stages.verifiedFirstCall).toBe(false);
    expect(result.stages.verifiedAfterRepair).toBe(true);
    expect(result.calls).toEqual(['learn-call', 'repair-call']);
    expect(result.verification?.verified).toBe(true);
    expect(result.unsupported).toEqual([]);
  });

  it('without a callRepair, reports the first-call verification as final', async () => {
    // SPEC 6.1 needs >= 3 data rows below the header to recognize one at all.
    const inputBytes = await xlsxBytes(
      ['ID', 'Val'],
      [
        [101, 5],
        [102, 9],
        [103, 2],
        [104, 7],
      ],
    );
    const outputBytes = await xlsxBytes(
      ['ID', 'Doubled'],
      [
        [101, 10],
        [102, 18],
        [103, 4],
        [104, 14],
      ],
    );
    const wrong: LearnResult = {
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'ID', type: 'integer' },
          { id: 'val', header: 'Val', type: 'integer' },
        ],
      },
      // Always 999, never matching the real "Doubled" values: guaranteed to fail
      // full verification on every row.
      transform: { computed: [{ id: 'x', type: 'integer', expr: { const: 999 } }], valueMaps: [], sort: [] },
      output: {
        sheetName: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'ID', from: 'id' },
          { header: 'Doubled', from: 'x' },
        ],
      },
      validations: [],
      unsupported: [],
      assumptions: [],
    };
    const target: Format = formatOf(wrong);
    const result = await learnFromExamples({
      input: { bytes: inputBytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      target,
      callLearn: async () => ok(wrong),
    });
    expect(result.stages.browserRepairUsed).toBe(false);
    expect(result.verification?.verified).toBe(false);
    expect(result.verification?.mismatches.length).toBeGreaterThan(0);
  });
});

describe('learnFromExamples: the LLM never returns anything usable', () => {
  it('reports null rules with no verification', async () => {
    const bytes = await xlsxBytes(
      ['ID', 'Name'],
      [
        [101, 'Dana'],
        [102, 'Yossi'],
        [103, 'Noa'],
        [104, 'Omer'],
      ],
    );
    // Reordered (not identical) so pre-flight doesn't block, but `target` is given so
    // the fast path - which would otherwise solve this trivially - is skipped.
    const outputBytes = await xlsxBytes(
      ['Name', 'ID'],
      [
        ['Dana', 101],
        ['Yossi', 102],
        ['Noa', 103],
        ['Omer', 104],
      ],
    );
    const target: Format = formatOf({
      schemaVersion: 1,
      input: {
        sheet: { pick: 'first' },
        headerRow: 'auto',
        columns: [
          { id: 'id', header: 'ID', type: 'integer' },
          { id: 'name', header: 'Name', type: 'text' },
        ],
      },
      transform: { computed: [], valueMaps: [], sort: [] },
      output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Name', from: 'name' }, { header: 'ID', from: 'id' }] },
      validations: [],
      unsupported: [],
      assumptions: [],
    });
    const result = await learnFromExamples({
      input: { bytes, name: 'in.xlsx' },
      output: { bytes: outputBytes, name: 'out.xlsx' },
      masking: false,
      tier: 'registered',
      target,
      callLearn: async () => ok(null, ['x']),
    });
    expect(result.path).toBe('llm');
    expect(result.rules).toBeNull();
    expect(result.verification).toBeNull();
    expect(result.calls).toEqual(['x']);
  });
});

describe('learnFromExamples: masking requires a key', () => {
  it('throws when masking is on but no key is given', async () => {
    const bytes = await xlsxBytes(['ID'], [[1], [2]]);
    await expect(
      learnFromExamples({
        input: { bytes, name: 'in.xlsx' },
        output: { bytes, name: 'out.xlsx' },
        masking: true,
        tier: 'registered',
        callLearn: async () => ok(null),
      }),
    ).rejects.toThrow(/masking/);
  });

  it('does not throw when a key is given', () => {
    // Sanity: createMasker itself accepts a plain key with no options.
    expect(() => createMasker(new TextEncoder().encode('k'))).not.toThrow();
  });
});
