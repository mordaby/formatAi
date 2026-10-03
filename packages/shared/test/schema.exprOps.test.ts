// SPEC 8.3 (v3) / LEARN_PROMPT §"Operations": every operation added in the v3
// amendments parses, and an obviously-invalid variant of each is rejected.
import { describe, expect, it } from 'vitest';
import { ExprSchema, isIsoDateLiteral } from '../src/rules/schema';

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

describe('ExprSchema: date and text operations added after learn-v6', () => {
  it('parses weekday, makeDate, toDate, dateLiteral, keepChars, titleCase and find', () => {
    expectValid({ op: 'weekday', arg: { col: 'd' } });
    expectValid({ op: 'makeDate', args: [{ col: 'y' }, { col: 'm' }, { const: 1 }] });
    expectValid({ op: 'toDate', arg: { col: 't' }, format: 'D MMMM YYYY' });
    expectValid({ op: 'dateLiteral', value: '2026-01-31' });
    expectValid({ op: 'keepChars', arg: { col: 't' }, chars: 'digits' });
    expectValid({ op: 'keepChars', arg: { col: 't' }, chars: 'letters' });
    expectValid({ op: 'keepChars', arg: { col: 't' }, chars: 'lettersAndDigits' });
    expectValid({ op: 'titleCase', arg: { col: 't' } });
    expectValid({ op: 'find', arg: { col: 't' }, search: ' - ' });
  });

  it('rejects the wrong shape for each', () => {
    expectInvalid({ op: 'weekday', args: [{ col: 'd' }] });
    expectInvalid({ op: 'makeDate', args: [{ col: 'y' }, { col: 'm' }] }); // exactly three parts
    expectInvalid({ op: 'makeDate', args: [{ col: 'y' }, { col: 'm' }, { col: 'd' }, { col: 'x' }] });
    expectInvalid({ op: 'toDate', arg: { col: 't' } }); // format required
    expectInvalid({ op: 'toDate', arg: { col: 't' }, format: '' });
    expectInvalid({ op: 'keepChars', arg: { col: 't' }, chars: 'symbols' }); // a closed set, never a pattern
    expectInvalid({ op: 'keepChars', arg: { col: 't' }, chars: '[0-9]' });
    expectInvalid({ op: 'keepChars', arg: { col: 't' } });
    expectInvalid({ op: 'titleCase', arg: { col: 't' }, extra: 1 });
    expectInvalid({ op: 'find', arg: { col: 't' }, search: '' }); // a literal to look for
    expectInvalid({ op: 'find', arg: { col: 't' }, search: { col: 'x' } }); // never an expression
  });

  it('dateLiteral only takes a real YYYY-MM-DD date between 1900 and 9999', () => {
    for (const ok of ['1900-01-01', '2024-02-29', '1900-02-29', '9999-12-31', '2026-12-31']) expectValid({ op: 'dateLiteral', value: ok });
    for (const bad of ['2026-02-30', '2025-02-29', '1900-02-30', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-5', '26-01-05', '31/01/2026', '2026-01-31T00:00', '1899-12-31', '10000-01-01', '', 'today', '2026-01-3x']) {
      expectInvalid({ op: 'dateLiteral', value: bad });
    }
    expectInvalid({ op: 'dateLiteral', value: 20260131 });
    expectInvalid({ op: 'dateLiteral' });
  });

  it('isIsoDateLiteral agrees', () => {
    expect(isIsoDateLiteral('2026-01-31')).toBe(true);
    expect(isIsoDateLiteral('2026-02-29')).toBe(false);
    expect(isIsoDateLiteral('2028-02-29')).toBe(true);
    expect(isIsoDateLiteral('2100-02-29')).toBe(false);
    expect(isIsoDateLiteral('2000-02-29')).toBe(true);
  });
});
