import { describe, expect, it, vi } from 'vitest';
import { TURNSTILE_SITEVERIFY_URL, createTurnstileVerifier } from '../../src/protection/turnstile.js';
import { makeTurnstileFetch } from './harness.js';

describe('createTurnstileVerifier (SPEC 9.5)', () => {
  it('verifies a token against Cloudflare siteverify with the secret, the token and the client IP', async () => {
    const fake = makeTurnstileFetch(['good']);
    const v = createTurnstileVerifier({ secret: 'the-secret', production: true, fetchFn: fake.fn });

    expect(v.enabled).toBe(true);
    expect(await v.verify('good', '203.0.113.7')).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(fake.calls[0]!.body.get('secret')).toBe('the-secret');
    expect(fake.calls[0]!.body.get('response')).toBe('good');
    expect(fake.calls[0]!.body.get('remoteip')).toBe('203.0.113.7');
  });

  it('rejects a token Cloudflare says is invalid', async () => {
    const fake = makeTurnstileFetch(['good']);
    const v = createTurnstileVerifier({ secret: 's', production: true, fetchFn: fake.fn });
    expect(await v.verify('bad', '1.2.3.4')).toBe(false);
  });

  it('rejects a missing, non-string, empty or oversized token without calling Cloudflare', async () => {
    const fake = makeTurnstileFetch(['good']);
    const v = createTurnstileVerifier({ secret: 's', production: true, fetchFn: fake.fn });
    for (const token of [undefined, null, 42, {}, '', 'x'.repeat(2049)]) {
      expect(await v.verify(token, '1.2.3.4')).toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('fails closed when Cloudflare is unreachable, times out, errors, or answers nonsense', async () => {
    const make = (fetchFn: typeof fetch) => createTurnstileVerifier({ secret: 's', production: true, fetchFn });
    expect(await make((async () => Promise.reject(new Error('network down'))) as typeof fetch).verify('t', 'ip')).toBe(false);
    expect(await make((async () => new Response('nope', { status: 500 })) as typeof fetch).verify('t', 'ip')).toBe(false);
    expect(await make((async () => new Response('not json', { status: 200 })) as typeof fetch).verify('t', 'ip')).toBe(false);
    expect(await make((async () => new Response('{"success":"yes"}', { status: 200 })) as typeof fetch).verify('t', 'ip')).toBe(false);
  });

  it('skips verification with a one-time warning when the secret is unset outside production', async () => {
    const warn = vi.fn();
    const fake = makeTurnstileFetch([]);
    const v = createTurnstileVerifier({ secret: undefined, production: false, fetchFn: fake.fn, warn });

    expect(v.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(await v.verify(undefined, '1.2.3.4')).toBe(true);
    expect(await v.verify('anything', '1.2.3.4')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(0);
  });

  it('TURNSTILE_DISABLED: the owner switch turns it off in production too, whatever the secret (a placeholder included), with a warning', async () => {
    const fake = makeTurnstileFetch(['good']);
    const warn = vi.fn();
    for (const secret of [undefined, 'pending']) {
      const v = createTurnstileVerifier({ secret, production: true, disabledByOwner: true, fetchFn: fake.fn, warn });
      expect(v.enabled).toBe(false);
      expect(await v.verify(undefined, '203.0.113.7')).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TURNSTILE_DISABLED'));
  });

  it('is a startup error when the secret is unset in production', () => {
    expect(() => createTurnstileVerifier({ secret: undefined, production: true })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() => createTurnstileVerifier({ secret: '', production: true })).toThrow(/TURNSTILE_SECRET_KEY/);
  });
});
