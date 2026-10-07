// API audit (2026-10-07): the rule parameters the engine uses as sizes are bounded (`limits.rules.maxRoundDigits` / `maxPadLength` /
// `maxLengthEquals` / `maxBlankRowsAfter`). Unbounded, one AI answer or one saved format could crash or hang the engine: padLeft to 1e9
// characters, round to 1e9 digits, 1e9 blank rows after every group.
import { describe, expect, it } from 'vitest';
import { limits } from '../src';
import { ExprSchema, GroupSchema, InputColumnSchema, ValidationSchema } from '../src/rules/schema';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => schema.safeParse(v).success;

describe('size parameters of a rule', () => {
  it('the numbers', () => {
    expect(limits.rules).toMatchObject({ maxRoundDigits: 15, maxPadLength: 100, maxLengthEquals: 100, maxBlankRowsAfter: 20 });
  });

  it('round: at most 15 places on either side of the point', () => {
    const round = (digits: number) => ({ op: 'round', arg: { col: 'a' }, digits });
    expect(ok(ExprSchema, round(2))).toBe(true);
    expect(ok(ExprSchema, round(limits.rules.maxRoundDigits))).toBe(true);
    expect(ok(ExprSchema, round(-limits.rules.maxRoundDigits))).toBe(true);
    expect(ok(ExprSchema, round(limits.rules.maxRoundDigits + 1))).toBe(false);
    expect(ok(ExprSchema, round(-limits.rules.maxRoundDigits - 1))).toBe(false);
    expect(ok(ExprSchema, round(1e9))).toBe(false);
  });

  it('padLeft: in an expression and on an input column', () => {
    const pad = (length: number) => ({ op: 'padLeft', arg: { col: 'a' }, length, char: '0' });
    expect(ok(ExprSchema, pad(limits.rules.maxPadLength))).toBe(true);
    expect(ok(ExprSchema, pad(limits.rules.maxPadLength + 1))).toBe(false);
    expect(ok(ExprSchema, pad(1e9))).toBe(false);
    const col = (padLeft: number) => ({ id: 'id', header: 'ID', type: 'idLike', padLeft });
    expect(ok(InputColumnSchema, col(9))).toBe(true);
    expect(ok(InputColumnSchema, col(limits.rules.maxPadLength + 1))).toBe(false);
  });

  it('lengthEquals', () => {
    const check = (length: number) => ({ on: 'output', column: 'ID', rule: 'lengthEquals', length, severity: 'flag' });
    expect(ok(ValidationSchema, check(9))).toBe(true);
    expect(ok(ValidationSchema, check(limits.rules.maxLengthEquals))).toBe(true);
    expect(ok(ValidationSchema, check(limits.rules.maxLengthEquals + 1))).toBe(false);
  });

  it('blankRowsAfter', () => {
    const group = (blankRowsAfter: number) => ({ by: 'region', showDetailRows: true, blankRowsAfter });
    expect(ok(GroupSchema, group(1))).toBe(true);
    expect(ok(GroupSchema, group(limits.rules.maxBlankRowsAfter))).toBe(true);
    expect(ok(GroupSchema, group(limits.rules.maxBlankRowsAfter + 1))).toBe(false);
    expect(ok(GroupSchema, group(1e9))).toBe(false);
  });
});
