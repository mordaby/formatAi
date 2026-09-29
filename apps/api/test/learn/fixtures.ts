// Shared fixtures for the learn orchestration tests: a minimal but real payload/rules
// pair (ID copied, Total = Amount x 2), small enough to reason about by hand.
import { formulaRulesToWire } from '@formatai/engine';
import { toWire, type LearnPayload, type LearnResult } from '@formatai/shared';

export function basicPayload(overrides: Partial<LearnPayload> = {}): LearnPayload {
  return {
    masking: false,
    input: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      layout: { headerRow: 0, rowsAbove: 0, footerFirstCell: [] },
      columns: [
        { i: 0, header: 'ID', type: 'idLike' },
        { i: 1, header: 'Amount', type: 'decimal' },
      ],
    },
    output: {
      file: { type: 'xlsx' },
      layout: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        headerRow: 0,
        headerBold: false,
        summary: false,
        groupBy: null,
        summaryRows: [],
        sort: null,
      },
      columns: [
        { i: 0, header: 'ID', type: 'idLike' },
        { i: 1, header: 'Total', type: 'decimal' },
      ],
    },
    samples: [
      { in: ['A1', 10], out: ['A1', 20] },
      { in: ['A2', 5], out: ['A2', 10] },
    ],
    hints: [],
    ...overrides,
  };
}

/** The correct rules for `basicPayload()`: Total = Amount x 2. */
export function correctRules(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'id', header: 'ID', type: 'idLike' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: {
      computed: [
        { id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 2 }] } },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'ID', from: 'id' },
        { header: 'Total', from: 'total' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** Same shape as `correctRules()`, but Total = Amount (wrong multiplier: a "diff"
 * failure - schema/reference/type/limit-clean, but wrong on the samples). */
export function wrongRoundingRules(): LearnResult {
  const rules = correctRules();
  return {
    ...rules,
    transform: {
      ...rules.transform,
      computed: [{ id: 'total', type: 'decimal', expr: { op: 'mul', args: [{ col: 'amount' }, { const: 1 }] } }],
    },
  };
}

/**
 * Invalid at the schema layer: an unknown op, sent as a raw (non-string) Expr node
 * directly on the wire, bypassing learn-v5's formula-text step - the real structured-
 * output schema would never let a model emit this (every expr position is a plain
 * `string`, SPEC 8.3), but `runChecks`'s layer-0 (`formulaRulesFromWire`) only ever
 * touches STRING expr positions, so a non-string value here passes straight through to
 * `LearnResultSchema.safeParse`, which is what actually rejects the unknown op - the
 * same defense-in-depth `fromWire`'s own tests rely on for a provider that doesn't
 * fully enforce its schema.
 */
export function schemaBrokenRulesJson(): unknown {
  const rules = correctRules();
  return toWire({
    ...rules,
    transform: {
      ...rules.transform,
      computed: [{ id: 'total', type: 'decimal', expr: { op: 'multiplyByTwo', arg: { col: 'amount' } } as never }],
    },
  });
}

/** learn-v5: the LLM writes every expr as formula text - `formulaRulesToWire` prints
 * `correctRules()`'s real Expr trees back to that text before the usual pairs
 * conversion, so this is exactly the wire shape a real structured-output call returns. */
export function correctRulesWireJson(): unknown {
  // See learn.ts's repairContentBlock for why this structural cast is safe.
  return toWire(formulaRulesToWire(correctRules()) as unknown as LearnResult);
}

export function wrongRoundingWireJson(): unknown {
  return toWire(formulaRulesToWire(wrongRoundingRules()) as unknown as LearnResult);
}
