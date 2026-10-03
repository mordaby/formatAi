import { describe, expect, it } from 'vitest';
import { createMasker } from '../../../src/learn/mask';

const key = new TextEncoder().encode('test-key-same-id');

describe('masking: the same ID gets the same fake in an ID column and inside text', () => {
  it('a valid Israeli ID inside a text cell matches the ID column fake (combined columns stay learnable)', () => {
    const m = createMasker(key);
    const idCell = m.maskCell('312345002', 'idLike') as string;
    const combined = m.maskCell('312345002 - Cohen', 'text') as string;
    expect(combined.startsWith(`${idCell} - `)).toBe(true);
    expect(idCell).not.toBe('312345002');
  });

  it('works in either order (text first, then the ID column)', () => {
    const m = createMasker(key);
    const combined = m.maskCell('ID 040217763: Levi', 'text') as string;
    const idCell = m.maskCell('040217763', 'idLike') as string;
    expect(combined).toContain(idCell);
  });

  it('short numbers in text keep plain word masking', () => {
    const m = createMasker(key);
    const a = m.maskCell('Qty 18', 'text') as string;
    expect(a).toMatch(/^\S+ \d\d$/);
  });

  it('the fake unmasks back to the real ID', () => {
    const m = createMasker(key);
    const combined = m.maskCell('312345002 - Cohen', 'text') as string;
    const fakeId = combined.split(' - ')[0]!;
    expect(m.fakeToReal.get(fakeId)).toBe('312345002');
  });
});
