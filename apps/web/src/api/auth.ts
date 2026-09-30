// The sign-in half of the API client (SPEC 12, 5 E): which providers can be offered, who is signed in, sign out,
// the saved language, linking a second provider, and what is left of the AI learns. Sign-in itself is not a
// fetch: the browser navigates to `/api/auth/<provider>/start` and comes back to `returnTo` with the answer in
// the query (`?authError=` / `?linked=`), which `readAuthReturn` reads.
import type { AiLearnQuotaState, AuthProviderId, AuthProvidersResponse, AuthRedirectError, LearnQuotaResponse, MeResponse, MeUser } from '@formatai/shared';
import type { HttpRequest } from './http';

export interface AuthApi {
  /** GET /api/auth/providers: only what the server has configured, Google first. */
  providers(signal?: AbortSignal): Promise<AuthProviderId[]>;
  /** GET /api/me: the signed-in user, or null. */
  me(signal?: AbortSignal): Promise<MeUser | null>;
  /** POST /api/auth/logout. */
  logout(): Promise<void>;
  /** PATCH /api/me { uiLanguage }. */
  setLanguage(uiLanguage: 'he' | 'en'): Promise<MeUser | null>;
  /** POST /api/me/link/:provider/start: the provider's address to go to (a fetch cannot follow the redirect itself). */
  linkStart(provider: AuthProviderId, returnTo: string): Promise<string>;
  /** GET /api/learn/quota: what is left of the caller's AI learns (signed in only). */
  quota(signal?: AbortSignal): Promise<AiLearnQuotaState>;
}

export function createAuthApi(request: HttpRequest): AuthApi {
  return {
    providers: async (signal) => (await request<AuthProvidersResponse>('GET', '/api/auth/providers', undefined, signal)).providers,
    me: async (signal) => (await request<MeResponse>('GET', '/api/me', undefined, signal)).user,
    logout: async () => {
      await request<{ ok: true }>('POST', '/api/auth/logout', {});
    },
    setLanguage: async (uiLanguage) => (await request<MeResponse>('PATCH', '/api/me', { uiLanguage })).user,
    linkStart: async (provider, returnTo) => (await request<{ url: string }>('POST', `/api/me/link/${provider}/start`, { returnTo })).url,
    quota: async (signal) => (await request<LearnQuotaResponse>('GET', '/api/learn/quota', undefined, signal)).quota,
  };
}

/** Where a click on "Continue with <provider>" goes: the API starts the flow and brings the browser back to `returnTo`. */
export function signInUrl(baseUrl: string, provider: AuthProviderId, returnTo: string): string {
  return `${baseUrl}/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;
}

const AUTH_ERRORS: readonly AuthRedirectError[] = ['expired', 'denied', 'failed', 'sessionMismatch', 'identityInUse', 'providerLinked'];

export type AuthReturn = { kind: 'error'; code: AuthRedirectError } | { kind: 'linked'; provider: AuthProviderId };

/**
 * What the API put in the query when it sent the browser back: `?authError=<code>` or `?linked=<provider>`.
 * An unknown error value reads as `failed` (nothing else in a query string is ever trusted or shown).
 */
export function readAuthReturn(search: string): AuthReturn | null {
  const params = new URLSearchParams(search);
  const error = params.get('authError');
  if (error) return { kind: 'error', code: (AUTH_ERRORS as readonly string[]).includes(error) ? (error as AuthRedirectError) : 'failed' };
  const linked = params.get('linked');
  if (linked === 'google' || linked === 'microsoft') return { kind: 'linked', provider: linked };
  return null;
}

/** `search` without the two answer parameters (the address bar is cleaned once they are read). */
export function withoutAuthReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('authError');
  params.delete('linked');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
