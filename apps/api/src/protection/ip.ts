// Client IP handling for the per-IP limits (SPEC 9.5, 13). The raw IP is never stored or logged:
// counters are keyed by a keyed hash of it, and only for as long as the daily counter lives.
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

function expandIpv6(ip: string): number[] | null {
  if (ip.includes('.')) return null; // embedded IPv4 tail: rare, leave the address as is
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)));
  const head = parse(halves[0]!);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]!);
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * What one "IP" means for limits: an IPv4 address as is (IPv4-mapped IPv6 unwrapped), an IPv6
 * address as its /64 - one household/host can rotate through 2^64 addresses, so the full address
 * would make the per-IP limit meaningless.
 */
export function normalizeIp(raw: string | undefined): string {
  const ip = (raw ?? '').trim().toLowerCase().split('%', 1)[0]!;
  if (ip === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIP(ip) !== 6) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** SPEC 13 `ip:<hash>:<day>`: HMAC-SHA256 of the normalized IP under a server secret, hex. */
export function hashIp(ip: string | undefined, secret: string): string {
  return createHmac('sha256', secret).update(normalizeIp(ip)).digest('hex');
}
