// Signed cookie values (SPEC 12): `<payload>.<mac>` with an HMAC-SHA256 keyed by SESSION_SECRET.
// The `purpose` is part of the MAC input, so a value signed for one cookie (the session id) is never
// accepted as another (the sign-in flow state), even though both use the same secret.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const mac = (secret: string, purpose: string, payload: string): string =>
  createHmac('sha256', secret).update(purpose).update('\0').update(payload).digest('base64url');

export function signValue(secret: string, purpose: string, payload: string): string {
  return `${payload}.${mac(secret, purpose, payload)}`;
}

/** The payload of a value signed with `signValue`, or null when it is malformed or the MAC doesn't match. */
export function verifyValue(secret: string, purpose: string, signed: unknown): string | null {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(secret, purpose, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return payload;
}

/** A random URL-safe token (state, nonce, PKCE verifier, session id): 256 bits. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Sessions are stored under the hash of their id, so reading the collection can't take over a session. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---- the sign-in flow cookie: state, nonce and PKCE verifier between /start and /callback ----

export interface FlowState {
  provider: string;
  /** `signin`, or `link` to attach the provider to the already signed-in `userId`. */
  mode: 'signin' | 'link';
  state: string;
  nonce: string;
  codeVerifier: string;
  /** A same-site relative path (see `safeReturnTo`). */
  returnTo: string;
  userId?: string;
  /** Epoch ms. */
  expiresAt: number;
}

const FLOW_PURPOSE = 'flow';

export function encodeFlow(secret: string, flow: FlowState): string {
  return signValue(secret, FLOW_PURPOSE, Buffer.from(JSON.stringify(flow)).toString('base64url'));
}

/** The flow, or null when the cookie is missing, forged, malformed or older than `now`. */
export function decodeFlow(secret: string, cookie: unknown, nowMs: number): FlowState | null {
  const payload = verifyValue(secret, FLOW_PURPOSE, cookie);
  if (payload === null) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<FlowState>;
    if (
      typeof flow.provider !== 'string' ||
      (flow.mode !== 'signin' && flow.mode !== 'link') ||
      typeof flow.state !== 'string' ||
      typeof flow.nonce !== 'string' ||
      typeof flow.codeVerifier !== 'string' ||
      typeof flow.returnTo !== 'string' ||
      typeof flow.expiresAt !== 'number' ||
      flow.expiresAt <= nowMs
    ) {
      return null;
    }
    return flow as FlowState;
  } catch {
    return null;
  }
}
