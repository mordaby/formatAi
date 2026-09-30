// The `learnId` /api/learn hands back and /api/learn/repair requires (SPEC 9.3: "at most 1 extra
// call" per learn, and it belongs to the same learn - not a new one). It is signed and bound to its
// owner, so a repair can only follow a real learn by the same visitor, and it expires; the "only
// once" part is a `repair:<uuid>` usage counter (see `routes/learn.ts`).
//
// Format: `<uuid>.<expiresAtSec>.<base64url hmac>` over `learn|<owner>|<uuid>|<expiresAtSec>`.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

function sign(secret: string, owner: string, uuid: string, expSec: string): Buffer {
  return createHmac('sha256', secret).update(`learn|${owner}|${uuid}|${expSec}`).digest();
}

export function issueLearnId(secret: string, owner: string, now: Date, ttlMinutes: number): string {
  const uuid = randomUUID();
  const expSec = String(Math.floor(now.getTime() / 1000) + ttlMinutes * 60);
  return `${uuid}.${expSec}.${sign(secret, owner, uuid, expSec).toString('base64url')}`;
}

export type LearnIdCheck = { ok: true; uuid: string; expiresAt: Date } | { ok: false };

export function verifyLearnId(secret: string, owner: string, token: unknown, now: Date): LearnIdCheck {
  if (typeof token !== 'string' || token.length > 200) return { ok: false };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false };
  const [uuid, expSec, sig] = parts as [string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(uuid) || !/^\d{1,12}$/.test(expSec)) return { ok: false };

  const given = Buffer.from(sig, 'base64url');
  const expected = sign(secret, owner, uuid, expSec);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };

  const expiresAt = new Date(Number(expSec) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false };
  return { ok: true, uuid, expiresAt };
}
