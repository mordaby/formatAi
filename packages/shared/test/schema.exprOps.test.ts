// SPEC 8.3 (v3) / LEARN_PROMPT §"Operations": every operation added in the v3
// amendments parses, and an obviously-invalid variant of each is rejected.
import { describe, expect, it } from 'vitest';
import { ExprSchema } from '../src/rules/schema';

function expectValid(expr: unknown): void {
  const result = ExprSchema.safeParse(expr);
  expect(result.success, JSON.stringify(!result.success && result.error.issues, null, 2)).toBe(
    true,
  );
}

function expectInvalid(expr: unknown): void {
  expect(ExprSchema.safeParse(expr).success).toBe(false);
}

describe('ExprSchema: new v3 operations', () => {
  it('parses floor and ceil', () => {
    expectValid({ op: 'floor', arg: { col: 'a' } });
    expectValid({ op: 'ceil', arg: { col: 'a' } });
  });

  it('rejects floor/ceil with the wrong arity field', () => {
    expectInvalid({ op: 'floor', args: [{ col: 'a' }] });
  });

  it('parses mod with exactly two args', () => {
    expectValid({ op: 'mod', args: [{ col: 'a' }, { const: 3 }] });
  });

  it('rejects mod with one or three args', () => {
    expectInvalid({ op: 'mod', args: [{ col: 'a' }] });
    expectInvalid({ op: 'mod', args: [{ col: 'a' }, { const: 1 }, { const: 2 }] });
  });

  it('parses min and max with any number of args', () => {
    expectValid({ op: 'min', args: [{ col: 'a' }, { col: 'b' }, { const: 0 }] });
    expectValid({ op: 'max', args: [{ col: 'a' }, { col: 'b' }] });
  });

  it('rejects min/max with zero args', () => {
    expectInvalid({ op: 'min', args: [] });
  });

  it('parses split with a positive and a negative 1-based index', () => {
    expectValid({ op: 'split', arg: { col: 'a' }, separator: ';', index: 1 });
    expectValid({ op: 'split', arg: { col: 'a' }, separator: ';', index: -1 });
  });

  it('rejects split with a zero index', () => {
    expectInvalid({ op: 'split', arg: { col: 'a' }, separator: ';', index: 0 });
  });

  it('parses length', () => {
    expectValid({ op: 'length', arg: { col: 'a' } });
  });

  it('parses toNumber and toText (format optional)', () => {
    expectValid({ op: 'toNumber', arg: { col: 'a' } });
    expectValid({ op: 'toText', arg: { col: 'a' } });
    expectValid({ op: 'toText', arg: { col: 'a' }, format: '#,##0.00' });
  });

  it('rejects toNumber with an extra field', () => {
    expectInvalid({ op: 'toNumber', arg: { col: 'a' }, format: 'x' });
  });

  it('parses dateAdd with exactly one of days/months/years', () => {
    expectValid({ op: 'dateAdd', arg: { col: 'd' }, days: 30 });
    expectValid({ op: 'dateAdd', arg: { col: 'd' }, months: 1 });
    expectValid({ op: 'dateAdd', arg: { col: 'd' }, years: -1 });
  });

  it('rejects dateAdd with none or more than one of days/months/years', () => {
    expectInvalid({ op: 'dateAdd', arg: { col: 'd' } });
    expectInvalid({ op: 'dateAdd', arg: { col: 'd' }, days: 1, months: 1 });
  });

  it('parses dateDiff with two args and a unit', () => {
    expectValid({
      op: 'dateDiff',
      args: [{ col: 'a' }, { col: 'b' }],
      unit: 'days',
    });
  });

  it('rejects dateDiff with a bad unit', () => {
    expectInvalid({ op: 'dateDiff', args: [{ col: 'a' }, { col: 'b' }], unit: 'weeks' });
  });

  it('parses endOfMonth', () => {
    expectValid({ op: 'endOfMonth', arg: { col: 'd' } });
  });

  it('parses switch with at least one case and an else', () => {
    expectValid({
      op: 'switch',
      cases: [{ when: { op: 'eq', args: [{ col: 'a' }, { const: 1 }] }, then: { const: 'x' } }],
      else: { const: 'y' },
    });
  });

  it('rejects switch with zero cases', () => {
    expectInvalid({ op: 'switch', cases: [], else: { const: 'y' } });
  });

  it('parses lookup', () => {
    expectValid({
      op: 'lookup',
      table: 'rates',
      key: { col: 'code' },
      return: 'rate',
      onMissing: 'flag',
    });
  });

  it('rejects lookup with a bad onMissing', () => {
    expectInvalid({
      op: 'lookup',
      table: 'rates',
      key: { col: 'code' },
      return: 'rate',
      onMissing: 'guess',
    });
  });

  it('parses call with any number of args, including zero', () => {
    expectValid({ op: 'call', fn: 'netOf', args: [] });
    expectValid({ op: 'call', fn: 'netOf', args: [{ col: 'a' }, { const: 0.17 }] });
  });

  it('rejects call missing fn', () => {
    expectInvalid({ op: 'call', args: [] });
  });

  it('parses the param leaf', () => {
    expectValid({ param: 'gross' });
  });

  it('parses the new condition ops: oneOf, startsWith, endsWith, contains', () => {
    expectValid({ op: 'oneOf', arg: { col: 'a' }, values: ['x', 'y', 1, null] });
    expectValid({ op: 'startsWith', arg: { col: 'a' }, text: 'AB' });
    expectValid({ op: 'endsWith', arg: { col: 'a' }, text: 'CD' });
    expectValid({ op: 'contains', arg: { col: 'a' }, text: 'mid' });
  });

  it('rejects oneOf with an empty values array', () => {
    expectInvalid({ op: 'oneOf', arg: { col: 'a' }, values: [] });
  });

  it('rejects an unknown operation name', () => {
    expectInvalid({ op: 'multiplyByTwo', arg: { col: 'a' } });
  });

  it('rejects a made-up leaf shape', () => {
    expectInvalid({ notALeaf: 'x' });
  });
});
