// The sign-in providers (SPEC 12): a small table, so adding a provider is an entry here plus its
// `<PREFIX>_CLIENT_ID` / `<PREFIX>_CLIENT_SECRET` env keys - the OIDC code (`oidc.ts`) is provider-blind.
import type { Env } from '../env.js';
import type { AuthProvider, UserIdentity } from '../models.js';

/** The verified claims of an ID token (signature, issuer, audience, expiry and nonce were checked by openid-client). */
export type IdClaims = Readonly<Record<string, unknown>>;

/** What a provider says about the person - the identity is `provider` + `subject` (+ `tenantId`), never the email. */
export type ProviderIdentity = UserIdentity & {
  name?: string;
  avatarUrl?: string;
};

export interface ProviderSpec {
  label: string;
  /** The OpenID Connect issuer (its `/.well-known/openid-configuration` is discovered). */
  issuer: string;
  /** Env key prefix: `<PREFIX>_CLIENT_ID`, `<PREFIX>_CLIENT_SECRET`. */
  envPrefix: string;
  /** SPEC 12 scopes. */
  scopes: readonly string[];
  /** The person behind a validated ID token, or null when it doesn't identify one. */
  identity(claims: IdClaims): ProviderIdentity | null;
}

/** A provider with its credentials: only providers with both are offered. */
export interface ProviderConfig extends ProviderSpec {
  id: AuthProvider;
  clientId: string;
  clientSecret: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** `email_verified` is a boolean in Google's ID tokens (older ones sent the string "true"). Absent = not verified. */
const isTrue = (v: unknown): boolean => v === true || v === 'true';

/** Google: the account is `sub`. Only a `true` email_verified counts as a verified email. */
export function googleIdentity(claims: IdClaims): ProviderIdentity | null {
  const subject = str(claims.sub);
  if (!subject) return null;
  return {
    provider: 'google',
    subject,
    email: str(claims.email) ?? '',
    emailVerified: isTrue(claims.email_verified),
    ...(str(claims.name) ? { name: str(claims.name) } : {}),
    ...(str(claims.picture) ? { avatarUrl: str(claims.picture) } : {}),
  };
}

/**
 * Microsoft: the account is the tenant id (`tid`) plus the object id (`oid`) - `sub` is per application
 * and the email is not verified by Microsoft, so it is only ever kept as information (SPEC 12: never merge
 * accounts by email, an account-takeover risk). `email_verified` is honoured only when present and true.
 */
export function microsoftIdentity(claims: IdClaims): ProviderIdentity | null {
  const subject = str(claims.oid);
  const tenantId = str(claims.tid);
  if (!subject || !tenantId) return null;
  return {
    provider: 'microsoft',
    subject,
    tenantId,
    email: str(claims.email) ?? str(claims.preferred_username) ?? '',
    emailVerified: isTrue(claims.email_verified),
    ...(str(claims.name) ? { name: str(claims.name) } : {}),
  };
}

const SCOPES = ['openid', 'email', 'profile'] as const;

/** Google first: the UI shows the providers in this order (SPEC 12). */
export const PROVIDER_TABLE: Record<AuthProvider, ProviderSpec> = {
  google: {
    label: 'Google',
    issuer: 'https://accounts.google.com',
    envPrefix: 'GOOGLE',
    scopes: SCOPES,
    identity: googleIdentity,
  },
  microsoft: {
    label: 'Microsoft',
    // The `common` endpoint accepts personal and work/school accounts (SPEC 12).
    issuer: 'https://login.microsoftonline.com/common/v2.0',
    envPrefix: 'MICROSOFT',
    scopes: SCOPES,
    identity: microsoftIdentity,
  },
};

/** The providers whose credentials are configured, in table order. Others are simply not offered. */
export function loadProviders(env: Env): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const [id, spec] of Object.entries(PROVIDER_TABLE) as Array<[AuthProvider, ProviderSpec]>) {
    const clientId = env[`${spec.envPrefix}_CLIENT_ID` as keyof Env];
    const clientSecret = env[`${spec.envPrefix}_CLIENT_SECRET` as keyof Env];
    if (typeof clientId === 'string' && typeof clientSecret === 'string') {
      out.push({ ...spec, id, clientId, clientSecret });
    }
  }
  return out;
}

export function isAuthProvider(value: string): value is AuthProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_TABLE, value);
}
