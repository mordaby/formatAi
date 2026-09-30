import { describe, expect, it } from 'vitest';
import { issueLearnId, verifyLearnId } from '../../src/protection/learnId.js';

const now = new Date('2026-09-30T12:00:00.000Z');
const GROUP = 'abc123def456';

describe('learnId (SPEC 9.3, 21 v5)', () => {
  it('verifies for the owner it was issued to, within its lifetime, and carries its group', () => {
    const id = issueLearnId('secret', 'user:AAA', now, 60, GROUP);
    const check = verifyLearnId('secret', 'user:AAA', id, now);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(check.expiresAt.getTime()).toBe(now.getTime() + 60 * 60_000);
      expect(check.group).toBe(GROUP);
    }
  });

  it('is bound to its owner', () => {
    const id = issueLearnId('secret', 'user:AAA', now, 60, GROUP);
    expect(verifyLearnId('secret', 'user:BBB', id, now).ok).toBe(false);
  });

  it('is bound to the server secret', () => {
    const id = issueLearnId('secret', 'user:AAA', now, 60, GROUP);
    expect(verifyLearnId('other-secret', 'user:AAA', id, now).ok).toBe(false);
  });

  it('expires', () => {
    const id = issueLearnId('secret', 'user:AAA', now, 60, GROUP);
    expect(verifyLearnId('secret', 'user:AAA', id, new Date(now.getTime() + 61 * 60_000)).ok).toBe(false);
  });

  it('rejects tampering (also of the group: a client cannot move a learn to another example pair) and garbage', () => {
    const id = issueLearnId('secret', 'user:AAA', now, 60, GROUP);
    const [uuid, exp, group, sig] = id.split('.') as [string, string, string, string];
    expect(verifyLearnId('secret', 'user:AAA', `${uuid}.${Number(exp) + 3600}.${group}.${sig}`, now).ok).toBe(false);
    expect(verifyLearnId('secret', 'user:AAA', `${uuid}.${exp}.${'0'.repeat(12)}.${sig}`, now).ok).toBe(false);
    expect(verifyLearnId('secret', 'user:AAA', `${uuid}.${exp}.${group}.${sig.slice(0, -2)}xx`, now).ok).toBe(false);
    for (const bad of [undefined, null, 42, '', 'a.b', 'a.b.c', 'a.b.c.d.e', 'x'.repeat(500)]) {
      expect(verifyLearnId('secret', 'user:AAA', bad, now).ok).toBe(false);
    }
  });

  it('issues a different id every time, and only for a hex group tag', () => {
    expect(issueLearnId('s', 'o', now, 1, GROUP)).not.toBe(issueLearnId('s', 'o', now, 1, GROUP));
    expect(() => issueLearnId('s', 'o', now, 1, 'not hex!')).toThrow();
  });
});
