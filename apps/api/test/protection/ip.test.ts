import { describe, expect, it } from 'vitest';
import { hashIp, normalizeIp } from '../../src/protection/ip.js';

describe('normalizeIp', () => {
  it('keeps IPv4 as is and unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses an IPv6 address to its /64, so rotating the low bits does not dodge the limit', () => {
    const a = normalizeIp('2001:db8:aaaa:bbbb:1:2:3:4');
    const b = normalizeIp('2001:0db8:AAAA:bbbb:ffff:ffff:ffff:ffff');
    const c = normalizeIp('2001:db8:aaaa:cccc::1');
    expect(a).toBe('2001:db8:aaaa:bbbb::/64');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('expands :: correctly and drops a zone id', () => {
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('never returns an empty id', () => {
    expect(normalizeIp(undefined)).toBe('unknown');
    expect(normalizeIp('')).toBe('unknown');
  });
});

describe('hashIp (SPEC 13 ip:<hash>:<day>)', () => {
  it('is a stable hex digest that depends on the secret and hides the address', () => {
    const h = hashIp('203.0.113.7', 'secret-1');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp('203.0.113.7', 'secret-1')).toBe(h);
    expect(hashIp('203.0.113.7', 'secret-2')).not.toBe(h);
    expect(hashIp('203.0.113.8', 'secret-1')).not.toBe(h);
    expect(h).not.toContain('203');
  });

  it('gives every address in one IPv6 network the same hash', () => {
    expect(hashIp('2001:db8::1', 's')).toBe(hashIp('2001:db8::ffff', 's'));
  });
});
