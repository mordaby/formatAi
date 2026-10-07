// Cloudflare Turnstile server-side verification (SPEC 9.5: "Turnstile is required" for what a visitor sends - today the public forms;
// the AI step is for signed-in users only, SPEC 21 v5, and asks no token). Uses `fetch` (injectable for tests) - no SDK. The token and the secret are never logged.
import { limits } from '@formatai/shared';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare documents tokens as at most 2048 characters; anything longer is rejected without a call. */
const MAX_TOKEN_CHARS = 2048;

export interface TurnstileVerifier {
  /** False when verification is skipped (no secret configured outside production). */
  readonly enabled: boolean;
  /** True when `token` is a valid, unused Turnstile token for this visitor. Never throws. */
  verify(token: unknown, remoteIp: string | undefined): Promise<boolean>;
}

export interface CreateTurnstileVerifierOptions {
  /** `TURNSTILE_SECRET_KEY`. */
  secret: string | undefined;
  production: boolean;
  /** `TURNSTILE_DISABLED=true` (env.ts): the owner turned Turnstile off on purpose - allowed in production, with a warning. */
  disabledByOwner?: boolean;
  /** Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Called once, when verification is being skipped for lack of a secret (dev only). */
  warn?: (message: string) => void;
}

/**
 * - Secret set: every `verify` call goes to Cloudflare's siteverify; any failure (bad token,
 *   network error, timeout, non-2xx, malformed reply) is a rejection - it fails closed.
 * - Secret unset, not production: verification is skipped with a one-time warning, so local
 *   development needs no Cloudflare account.
 * - Secret unset in production: throws - an unprotected production API is a startup error.
 */
export function createTurnstileVerifier(opts: CreateTurnstileVerifierOptions): TurnstileVerifier {
  const { secret, production, warn } = opts;
  const timeoutMs = opts.timeoutMs ?? limits.protection.turnstileTimeoutMs;

  // The owner's switch wins over the keys (a placeholder secret would otherwise reject every visitor).
  if (opts.disabledByOwner) {
    warn?.('Turnstile is OFF (TURNSTILE_DISABLED=true): requests and forms from visitors are protected by the rate limits only. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, then remove TURNSTILE_DISABLED.');
    return { enabled: false, verify: async () => true };
  }

  if (!secret) {
    if (production) {
      throw new Error('TURNSTILE_SECRET_KEY is required when NODE_ENV=production (the public forms need Turnstile)');
    }
    let warned = false;
    return {
      enabled: false,
      async verify() {
        if (!warned) {
          warned = true;
          warn?.('TURNSTILE_SECRET_KEY is not set: skipping Turnstile verification (development only)');
        }
        return true;
      },
    };
  }

  return {
    enabled: true,
    async verify(token, remoteIp) {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return false;
      const fetchFn = opts.fetchFn ?? fetch;
      try {
        const form = new URLSearchParams({ secret, response: token });
        if (remoteIp) form.set('remoteip', remoteIp);
        const res = await fetchFn(TURNSTILE_SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { success?: unknown };
        return body.success === true;
      } catch {
        return false;
      }
    },
  };
}
