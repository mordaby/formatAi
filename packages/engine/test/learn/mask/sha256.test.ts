import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/learn/mask/sha256';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('sha256', () => {
  it('matches known digests for the empty string and "abc"', () => {
    expect(bytesToHex(sha256(utf8(''))))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bytesToHex(sha256(utf8('abc'))))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the known digest for a message spanning multiple 64-byte blocks', () => {
    // A 56-byte message: pads to two 64-byte blocks once the 0x80 marker and
    // 64-bit length are appended, exercising the multi-block path.
    const msg = 'abcdbcdcdecdefdefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(bytesToHex(sha256(utf8(msg))))
      .toBe('ae77592ecea88005ddb47a764152e3748972a1c39d3b236f02ab3c1631ade889');
  });

  it('produces a 32-byte digest deterministically (same input -> same output)', () => {
    const msg = utf8('formatAI masking test');
    const a = sha256(msg);
    const b = sha256(msg);
    expect(a).toHaveLength(32);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});
