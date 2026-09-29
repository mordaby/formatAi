import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalToPlain, excelRound, fromExcelNumber, parseNumber } from '../../src/values/numbers';

function expectEq(d: Decimal | null, expected: number | string) {
  expect(d).not.toBeNull();
  expect((d as Decimal).eq(expected)).toBe(true);
}

describe('fromExcelNumber', () => {
  it('collapses float noise to the 15-significant-digit value Excel would show', () => {
    expectEq(fromExcelNumber(0.1 + 0.2), '0.3');
  });

  it('handles whole numbers and zero', () => {
    expectEq(fromExcelNumber(100), 100);
    expectEq(fromExcelNumber(0), 0);
  });

  it('handles negative numbers', () => {
    expectEq(fromExcelNumber(-1.0000000000000002), -1);
  });
});

describe('parseNumber', () => {
  it('parses plain integers and decimals, trimmed', () => {
    expectEq(parseNumber('1234'), 1234);
    expectEq(parseNumber('  1234.5  '), 1234.5);
  });

  it('parses thousand separators', () => {
    expectEq(parseNumber('1,234.56'), 1234.56);
    expectEq(parseNumber('1,234,567'), 1234567);
  });

  it('parses currency prefix/suffix: shekel, dollar, euro, NIS, ש"ח', () => {
    expectEq(parseNumber('₪150.00'), 150);
    expectEq(parseNumber('150₪'), 150);
    expectEq(parseNumber('$99.99'), 99.99);
    expectEq(parseNumber('99.99$'), 99.99);
    expectEq(parseNumber('€50'), 50);
    expectEq(parseNumber('50 NIS'), 50);
    expectEq(parseNumber('ש"ח 200'), 200);
    expectEq(parseNumber('200 ש"ח'), 200);
  });

  it('parses a trailing percent sign by dividing by 100', () => {
    expectEq(parseNumber('50%'), 0.5);
    expectEq(parseNumber('12.5%'), 0.125);
  });

  it('parses negatives: leading -, unicode minus, parentheses, trailing -', () => {
    expectEq(parseNumber('-50'), -50);
    expectEq(parseNumber('−50'), -50); // unicode minus
    expectEq(parseNumber('(50.5)'), -50.5);
    expectEq(parseNumber('50.5-'), -50.5);
  });

  it('accepts a plain number input, applying the same float cleanup as fromExcelNumber', () => {
    expectEq(parseNumber(0.1 + 0.2), '0.3');
  });

  it('returns null for non-numeric or empty input', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('12a34')).toBeNull();
    expect(parseNumber(NaN)).toBeNull();
    expect(parseNumber(Infinity)).toBeNull();
  });
});

describe('excelRound', () => {
  it('rounds half away from zero, standard cases', () => {
    expectEq(excelRound(new Decimal('2.345'), 2), '2.35');
    expectEq(excelRound(new Decimal('-2.345'), 2), '-2.35');
  });

  it('rounds exact decimals correctly where binary floats fail (1.005 -> 1.01)', () => {
    expectEq(excelRound(new Decimal('1.005'), 2), '1.01');
  });

  it('supports negative digits (rounding to tens/hundreds)', () => {
    expectEq(excelRound(new Decimal('250'), -2), '300'); // exact tie, away from zero
    expectEq(excelRound(new Decimal('-250'), -2), '-300');
    expectEq(excelRound(new Decimal('2345'), -1), '2350');
  });

  it('leaves already-rounded values unchanged', () => {
    expectEq(excelRound(new Decimal('10'), 2), '10');
  });
});

describe('decimalToPlain', () => {
  it('renders plain decimal notation', () => {
    expect(decimalToPlain(new Decimal('123.456'))).toBe('123.456');
    expect(decimalToPlain(new Decimal('100'))).toBe('100');
  });

  it('never uses exponential notation, even for magnitudes that would trigger it', () => {
    const tiny = decimalToPlain(new Decimal('0.00000001'));
    expect(tiny).toBe('0.00000001');
    expect(tiny).not.toMatch(/e/i);

    const huge = decimalToPlain(new Decimal('123456789012345678901234'));
    expect(huge).toBe('123456789012345678901234');
    expect(huge).not.toMatch(/e/i);
  });
});
