import { describe, expect, it } from 'vitest';
import { issueLearnId, verifyLearnId } from '../../src/protection/learnId.js';

const now = new Date('2026-09-30T12:00:00.000Z');

describe('learnId (SPEC 9.3)', () => {
  it('verifies for the owner it was issued to, within its lifetime', () => {
    const id = issueLearnId('secret', 'anon:AAA', now, 60);
    const check = verifyLearnId('secret', 'anon:AAA', id, now);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(check.expiresAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    }
  });

  it('is bound to its owner', () => {
    const id = issueLearnId('secret', 'anon:AAA', now, 60);
    expect(verifyLearnId('secret', 'anon:BBB', id, now).ok).toBe(false);
  });

  it('is bound to the server secret', () => {
    const id = issueLearnId('secret', 'anon:AAA', now, 60);
    expect(verifyLearnId('other-secret', 'anon:AAA', id, now).ok).toBe(false);
  });

  it('expires', () => {
    const id = issueLearnId('secret', 'anon:AAA', now, 60);
    expect(verifyLearnId('secret', 'anon:AAA', id, new Date(now.getTime() + 61 * 60_000)).ok).toBe(false);
  });

  it('rejects tampering and garbage', () => {
    const id = issueLearnId('secret', 'anon:AAA', now, 60);
    const [uuid, exp, sig] = id.split('.') as [string, string, string];
    expect(verifyLearnId('secret', 'anon:AAA', `${uuid}.${Number(exp) + 3600}.${sig}`, now).ok).toBe(false);
    expect(verifyLearnId('secret', 'anon:AAA', `${uuid}.${exp}.${sig.slice(0, -2)}xx`, now).ok).toBe(false);
    for (const bad of [undefined, null, 42, '', 'a.b', 'a.b.c.d', 'x'.repeat(500)]) {
      expect(verifyLearnId('secret', 'anon:AAA', bad, now).ok).toBe(false);
    }
  });

  it('issues a different id every time', () => {
    expect(issueLearnId('s', 'o', now, 1)).not.toBe(issueLearnId('s', 'o', now, 1));
  });
});
