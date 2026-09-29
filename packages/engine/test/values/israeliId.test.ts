import { describe, expect, it } from 'vitest';
import { isValidIsraeliId, makeValidIsraeliId } from '../../src/values/israeliId';

describe('isValidIsraeliId', () => {
  it('accepts known valid ids', () => {
    expect(isValidIsraeliId('000000018')).toBe(true);
    expect(isValidIsraeliId('123456782')).toBe(true);
  });

  it('rejects a known invalid id', () => {
    expect(isValidIsraeliId('123456789')).toBe(false);
  });

  it('pads shorter digit strings to 9 before checking', () => {
    expect(isValidIsraeliId('18')).toBe(true); // pads to 000000018
  });

  it('rejects non-digit or out-of-range input', () => {
    expect(isValidIsraeliId('abc')).toBe(false);
    expect(isValidIsraeliId('')).toBe(false);
    expect(isValidIsraeliId('1234567890')).toBe(false); // 10 digits
    expect(isValidIsraeliId('-123456')).toBe(false);
  });
});

describe('makeValidIsraeliId', () => {
  it('produces the known valid id from its 8-digit seed', () => {
    expect(makeValidIsraeliId('12345678')).toBe('123456782');
  });

  it('always produces a valid id for any 8-digit seed', () => {
    for (const seed of ['00000001', '99999999', '00000000', '43219876']) {
      const id = makeValidIsraeliId(seed);
      expect(id).toHaveLength(9);
      expect(id.startsWith(seed)).toBe(true);
      expect(isValidIsraeliId(id)).toBe(true);
    }
  });

  it('throws on a seed that is not exactly 8 digits', () => {
    expect(() => makeValidIsraeliId('123')).toThrow();
    expect(() => makeValidIsraeliId('123456789')).toThrow();
  });
});
