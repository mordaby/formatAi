// SPEC 8.8 `sameAs` (21 v12 item 17): the marker of an open question about a column's rule - only code writes it, never the AI step.
import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/rules/check';
import { AiValidationSchema, isCodeCheck, LearnResultSchema, ValidationSchema, type LearnResult, type Validation } from '../src/rules/schema';
import { learnResultWireJsonSchema } from '../src/rules/wire';

function rules(validations: Validation[]): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'code', header: 'Code', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
    transform: { computed: [{ id: 'prefix', type: 'text', expr: { op: 'substr', arg: { col: 'code' }, start: 1, length: 2 } }], valueMaps: [], sort: [] },
    output: { sheetName: 'S', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Branch', from: 'prefix' }, { header: 'Amount', from: 'amount' }] },
    validations,
    unsupported: [],
    assumptions: [],
  };
}

const check: Validation = { column: 'prefix', rule: 'sameAs', expr: { const: '00' }, severity: 'flag' };

describe('the sameAs check', () => {
  it('is a stored validation kind (old files load unchanged), not one the AI step may write', () => {
    expect(ValidationSchema.safeParse(check).success).toBe(true);
    expect(LearnResultSchema.safeParse(rules([check])).success).toBe(true);
    expect(AiValidationSchema.safeParse(check).success).toBe(false);
    expect(JSON.stringify(learnResultWireJsonSchema())).not.toContain('sameAs');
    expect(isCodeCheck(check)).toBe(true);
    expect(isCodeCheck({ rule: 'cutoffRange' })).toBe(true);
    expect(isCodeCheck({ rule: 'oneOf' })).toBe(false);
  });

  it('is an input-side check (it reads this source columns): an output one, or one without an expression, is not one', () => {
    expect(ValidationSchema.safeParse({ ...check, on: 'input' }).success).toBe(true);
    expect(ValidationSchema.safeParse({ ...check, on: 'output', column: 'Branch' }).success).toBe(false);
    expect(ValidationSchema.safeParse({ column: 'prefix', rule: 'sameAs', severity: 'flag' }).success).toBe(false);
  });

  it('checkRules: its column and every column its expression reads must exist; an across-row function is refused there', () => {
    expect(checkRules(rules([check]))).toEqual([]);
    expect(checkRules(rules([{ ...check, expr: { op: 'substr', arg: { col: 'code' }, start: 3, length: 2 } }]))).toEqual([]);
    expect(checkRules(rules([{ ...check, column: 'nope' }])).map((p) => p.path)).toEqual(['validations[0].column']);
    expect(checkRules(rules([{ ...check, expr: { col: 'gone' } }])).map((p) => p.path)).toEqual(['validations[0].expr']);
    const window: Validation = { ...check, expr: { op: 'window', fn: 'runningSum', arg: { col: 'amount' } } as unknown as Validation extends { expr: infer E } ? E : never };
    expect(checkRules(rules([window])).some((p) => /across-row/.test(p.message))).toBe(true);
  });
});
