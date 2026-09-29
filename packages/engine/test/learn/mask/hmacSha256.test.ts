import { describe, expect, it } from 'vitest';
import { hmacSha256 } from '../../../src/learn/mask/hmacSha256';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function repeat(byte: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(byte);
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// RFC 4231 test vectors for HMAC-SHA-256 (https://www.rfc-editor.org/rfc/rfc4231).
// Full (untruncated) MACs, independently verified against Node's own `crypto`
// HMAC-SHA256 implementation for these exact key/data pairs.
describe('hmacSha256 (RFC 4231 test vectors)', () => {
  it('Test Case 1: key shorter than the block size', () => {
    const key = repeat(0x0b, 20);
    const data = ascii('Hi There');
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('Test Case 2: a short ASCII key and message', () => {
    const key = ascii('Jefe');
    const data = ascii('what do ya want for nothing?');
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('Test Case 3: key and data of the block size, all 0xaa/0xdd bytes', () => {
    const key = repeat(0xaa, 20);
    const data = repeat(0xdd, 50);
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
    );
  });

  it('Test Case 4: a key longer than 20 bytes but shorter than the block size', () => {
    const key = new Uint8Array(Array.from({ length: 25 }, (_, i) => i + 1));
    const data = repeat(0xcd, 50);
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
    );
  });

  it('Test Case 5: truncation vector, checked against the full (untruncated) MAC', () => {
    const key = repeat(0x0c, 20);
    const data = ascii('Test With Truncation');
    const full = bytesToHex(hmacSha256(key, data));
    // RFC 4231 gives HMAC-SHA-256-128 = a3b6167473100ee06e0c796c2955552 for this
    // case; the untruncated MAC must start with that same 128-bit prefix.
    expect(full.startsWith('a3b6167473100ee06e0c796c2955552')).toBe(true);
    expect(full).toBe('a3b6167473100ee06e0c796c2955552bfa6f7c0a6a8aef8b93f860aab0cd20c5');
  });

  it('Test Case 6: a key longer than the block size (65 bytes < key <= ... ), hashed first', () => {
    const key = repeat(0xaa, 131);
    const data = ascii('Test Using Larger Than Block-Size Key - Hash Key First');
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });

  it('Test Case 7: a key and data both longer than the block size', () => {
    const key = repeat(0xaa, 131);
    const data = ascii(
      'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
    );
    expect(bytesToHex(hmacSha256(key, data))).toBe(
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    );
  });

  it('is deterministic and key-sensitive', () => {
    const data = ascii('same message');
    const macA = hmacSha256(repeat(1, 32), data);
    const macB = hmacSha256(repeat(1, 32), data);
    const macC = hmacSha256(repeat(2, 32), data);
    expect(bytesToHex(macA)).toBe(bytesToHex(macB));
    expect(bytesToHex(macA)).not.toBe(bytesToHex(macC));
  });
});
