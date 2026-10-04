// The `learnId` /api/learn hands back and /api/learn/repair (and /api/learn/:learnId/outcome) require (SPEC 9.3:
// at most `limits.llm.browserRepairCalls` rounds of the learning loop per learn, and they belong to the same learn - not
// a new one). It is signed and bound to its owner, so a follow-up can only come from the same signed-in user, and it
// expires; the round cap is a `repair:<uuid>` usage counter, and what the learn already counted is a state counter
// (see `aiLearns.ts`).
//
// It also carries the learn's `group` - the tag of the example pair it belongs to (owner + structure hash,
// SPEC 21 v5 item 3) - so the failed-attempt counter of that pair can be found again without trusting the client.
//
// Format: `<uuid>.<expiresAtSec>.<group>.<base64url hmac>` over `learn|<owner>|<uuid>|<expiresAtSec>|<group>`.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

function sign(secret: string, owner: string, uuid: string, expSec: string, group: string): Buffer {
  return createHmac('sha256', secret).update(`learn|${owner}|${uuid}|${expSec}|${group}`).digest();
}

const GROUP_PATTERN = /^[0-9a-f]{1,64}$/;

export function issueLearnId(secret: string, owner: string, now: Date, ttlMinutes: number, group: string): string {
  if (!GROUP_PATTERN.test(group)) throw new Error('learnId group must be a lowercase hex tag');
  const uuid = randomUUID();
  const expSec = String(Math.floor(now.getTime() / 1000) + ttlMinutes * 60);
  return `${uuid}.${expSec}.${group}.${sign(secret, owner, uuid, expSec, group).toString('base64url')}`;
}

export type LearnIdCheck =
  | { ok: true; uuid: string; expiresAt: Date; group: string }
  | { ok: false };

export function verifyLearnId(secret: string, owner: string, token: unknown, now: Date): LearnIdCheck {
  if (typeof token !== 'string' || token.length > 200) return { ok: false };
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false };
  const [uuid, expSec, group, sig] = parts as [string, string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(uuid) || !/^\d{1,12}$/.test(expSec) || !GROUP_PATTERN.test(group)) return { ok: false };

  const given = Buffer.from(sig, 'base64url');
  const expected = sign(secret, owner, uuid, expSec, group);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };

  const expiresAt = new Date(Number(expSec) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false };
  return { ok: true, uuid, expiresAt, group };
}
