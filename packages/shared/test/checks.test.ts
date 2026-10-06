// AI code checks (learn-v9, docs/proposals/ai-code-checks.md): the gate the API holds the model's checks to (`acceptChecks`), a step's
// rounds as the API validates them (`CheckRoundsSchema`, `stepFits`), the one answer schema of a learn-v9 learn and its unwrap
// (`learnStepWireJsonSchema`, `splitStepAnswer`), and who gets learn-v9 (`learnChecksModeOf`).
import { describe, expect, it } from 'vitest';
import {
  acceptChecks,
  CheckRoundsSchema,
  learnChecksModeOf,
  learnStepWireJsonSchema,
  limits,
  newCheckRows,
  splitStepAnswer,
  stepBytes,
  stepFits,
  wireStepSchema,
  type CheckRound,
  type LearnPayload,
} from '../src/index';

const caps = limits.learn.checks;

function payload(samples = 2): LearnPayload {
  return {
    masking: false,
    input: { sheetName: 'S', direction: 'ltr', layout: { headerRow: 0, rowsAbove: 0, footerFirstCell: [] }, columns: [{ i: 0, header: 'A', type: 'integer' }] },
    output: {
      file: { type: 'xlsx' },
      layout: { sheetName: 'O', direction: 'ltr', language: 'en', titleRows: [], headerRow: 0, headerBold: false, summary: false, groupBy: null, summaryRows: [], sort: null },
      columns: [{ i: 0, header: 'B', type: 'integer' }],
    },
    samples: Array.from({ length: samples }, (_, i) => ({ in: [i], out: [i * 2] })),
    hints: [],
  };
}

describe('acceptChecks: the gate, with every cap', () => {
  it('keeps valid checks in order, at most 4, and drops the rest with one short line each (no value in it)', () => {
    const valid = { check: 'values', column: 'Class' };
    const { checks, dropped } = acceptChecks([
      { check: 'test', column: 'Class', rule: 'in1 * 2' },
      { check: 'plot', column: 'Secret value 123' },
      { check: 'ranges', column: 'Class' },
      valid,
      { check: 'rows', where: 'in0 > 1', limit: 9 },
      valid,
      valid,
      valid,
    ]);
    expect(checks).toHaveLength(caps.maxChecksPerRound);
    expect(checks[0]).toEqual({ check: 'test', column: 'Class', rule: 'in1 * 2' });
    expect(dropped).toEqual([
      'check 2 was not run: not one of the checks (test, ranges, dependsOn, values, rows)',
      'check 3 was not run: "ranges": "by" is missing or of the wrong kind',
      'check 5 was not run: "rows": limit is too long or has too many items',
      'check 8 was not run: at most 4 checks a round',
    ]);
    expect(dropped.join(' ')).not.toContain('Secret');
  });

  it('caps let (3), on (1-2), formula length, and refuses unknown fields', () => {
    const lets = Array.from({ length: caps.maxLets + 1 }, (_, i) => ({ id: `h${i}`, expr: '1' }));
    const r = acceptChecks([
      { check: 'values', column: 'x', let: lets },
      { check: 'dependsOn', column: 'x', on: ['a', 'b', 'c'] },
      { check: 'dependsOn', column: 'x', on: [] },
      { check: 'test', column: 'x', rule: 'x'.repeat(caps.maxFormulaChars + 1) },
      { check: 'values', column: 'x', extra: 1 },
    ]);
    expect(r.checks).toEqual([]);
    expect(r.dropped).toEqual([
      'check 1 was not run: "values": let is too long or has too many items',
      'check 2 was not run: "dependsOn": on is too long or has too many items',
      'check 3 was not run: "dependsOn": on is empty or too small',
      'check 4 was not run: "test": rule is too long or has too many items',
      'check 5 was not run: "values" takes no "extra"',
    ]);
    expect(acceptChecks([{ check: 'values', column: 'x', let: [{ id: '1bad', expr: '1' }] }]).dropped).toHaveLength(1);
  });

  it('a long list of bad checks is summed up, not listed', () => {
    const r = acceptChecks(Array.from({ length: 20 }, () => ({ check: 'nope' })));
    expect(r.dropped.length).toBeLessThanOrEqual(caps.maxChecksPerRound + 1);
    expect(r.dropped[r.dropped.length - 1]).toBe(`${20 - caps.maxChecksPerRound} more checks were not run`);
  });
});

describe('a step: the rounds the browser sends', () => {
  const round = (rows: CheckRound['answers'][number]): CheckRound => ({ checks: [{ check: 'rows', where: 'in0 > 0', limit: 2 }], answers: [rows] });

  it('validates the rounds: one answer per check, answers in their shapes, at most maxRounds', () => {
    expect(CheckRoundsSchema.safeParse([round({ matched: 3, rows: [{ in: [1], out: [2] }] })]).success).toBe(true);
    expect(CheckRoundsSchema.safeParse([round({ error: 'rule: expected ")" (at 4)' })]).success).toBe(true);
    expect(CheckRoundsSchema.safeParse([]).success).toBe(false);
    expect(CheckRoundsSchema.safeParse([{ checks: [{ check: 'values', column: 'x' }], answers: [] }]).success).toBe(false);
    expect(CheckRoundsSchema.safeParse([round({ matched: 3, rows: [], sneaky: 'x' } as never)]).success).toBe(false);
    expect(CheckRoundsSchema.safeParse(Array.from({ length: caps.maxRounds + 1 }, () => round({ matched: 0, rows: [] }))).success).toBe(false);
  });

  it('counts the rows the rounds show once each, not the ones the payload already carries', () => {
    const p = payload(2);
    const rounds = [round({ matched: 3, rows: [{ in: [0], out: [0] }, { in: [7], out: [14] }] }), round({ matched: 1, rows: [{ in: [7], out: [14] }] })];
    expect(newCheckRows(p, rounds)).toBe(1);
  });

  it('stepFits: the rounds, the rows with the payload\'s own, the byte cap on the whole body', () => {
    const p = payload(limits.learn.loop.maxRowsTotal - 1);
    const one = round({ matched: 1, rows: [{ in: [100], out: [200] }] });
    const two = round({ matched: 2, rows: [{ in: [100], out: [200] }, { in: [101], out: [202] }] });
    expect(stepFits(p, [one])).toBe(true);
    expect(stepFits(p, [two])).toBe(false);
    const big: CheckRound = { checks: [{ check: 'values', column: 'x'.repeat(200) }], answers: [{ error: 'e'.repeat(300) }] };
    const many = payload(2);
    many.hints = ['x'.repeat(limits.payload.maxBytes - 1000) as never];
    expect(stepBytes(many, [])).toBeLessThan(limits.payload.maxBytes);
    expect(stepFits(many, [big, big, big])).toBe(false);
  });
});

describe('the learn-v9 answer: one schema, { checks, rules }, exactly one of them', () => {
  it('both fields are required and nullable (so the OpenAI strict rewrite keeps the nulls), checks a discriminated union', () => {
    const schema = learnStepWireJsonSchema();
    expect(schema.required).toEqual(['checks', 'rules']);
    const props = schema.properties as Record<string, { anyOf: { type: string }[] }>;
    expect(props.checks!.anyOf.map((m) => m.type)).toEqual(['array', 'null']);
    expect(props.rules!.anyOf.map((m) => m.type)).toEqual(['object', 'null']);
    // no caps on the wire (not every provider takes them): they are in the prompt and in `acceptChecks`
    expect(JSON.stringify(props.checks)).not.toMatch(/maxItems|maxLength|"minimum"|"maximum"/);
  });

  it('the zod schema accepts a checks answer and a rules answer', () => {
    expect(wireStepSchema().safeParse({ checks: [{ check: 'ranges', column: 'C', by: 'Total' }], rules: null }).success).toBe(true);
    expect(wireStepSchema().safeParse({ checks: [{ check: 'plot' }], rules: null }).success).toBe(false);
  });

  it('splitStepAnswer: rules win; checks need at least one; anything else is invalid', () => {
    const rules = { schemaVersion: 1 };
    expect(splitStepAnswer({ checks: null, rules })).toEqual({ kind: 'rules', rules });
    expect(splitStepAnswer({ checks: [{ check: 'values', column: 'x' }], rules })).toEqual({ kind: 'rules', rules });
    expect(splitStepAnswer({ checks: [{ check: 'values', column: 'x' }], rules: null })).toEqual({ kind: 'checks', checks: [{ check: 'values', column: 'x' }] });
    expect(splitStepAnswer({ checks: [], rules: null }).kind).toBe('invalid');
    expect(splitStepAnswer({ checks: null, rules: null }).kind).toBe('invalid');
    expect(splitStepAnswer('nope').kind).toBe('invalid');
  });
});

describe('who gets learn-v9 in the app (LEARN_CHECKS)', () => {
  it('unset is the config default (off); off, admin, all in any case; anything else is null (the production check fails on it)', () => {
    expect(caps.mode).toBe('off');
    expect(learnChecksModeOf(undefined)).toBe('off');
    expect(learnChecksModeOf(' ')).toBe('off');
    expect(learnChecksModeOf('admin')).toBe('admin');
    expect(learnChecksModeOf('ALL')).toBe('all');
    expect(learnChecksModeOf('yes')).toBeNull();
  });
});
