// The one OpenID Connect implementation (SPEC 12): openid-client v6, authorization-code flow with PKCE.
// Everything provider-specific lives in the provider table (`providers.ts`); this file only talks OIDC.
import * as client from 'openid-client';
import type { IdClaims, ProviderConfig } from './providers.js';

/** What the sign-in flow keeps between the redirect out and the callback (see `signing.ts` `FlowState`). */
export interface FlowChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcClient {
  /** The provider's authorization URL: code flow, PKCE S256, the provider's scopes, our state and nonce. */
  authorizationUrl(
    provider: ProviderConfig,
    redirectUri: string,
    checks: FlowChecks,
    extra?: Record<string, string>,
  ): Promise<URL>;
  /**
   * Finishes the flow: checks `state`, exchanges the code (sending the PKCE verifier and the client secret),
   * validates the ID token (signature via the provider's JWKS, issuer, audience, expiry, nonce) and returns
   * its claims. `callbackUrl` is our redirect URI plus the provider's query string (the token request repeats that URI). Throws on any failure.
   */
  finish(provider: ProviderConfig, callbackUrl: URL, checks: FlowChecks): Promise<IdClaims>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain http is refused by openid-client, except for an issuer on this machine (dev and tests). */
function isLocalHttp(issuer: string): boolean {
  const url = new URL(issuer);
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

export function createOpenIdClient(): OidcClient {
  // One discovery per provider per process; a failed discovery is not cached, so the next request retries.
  const configs = new Map<string, Promise<client.Configuration>>();

  function configFor(provider: ProviderConfig): Promise<client.Configuration> {
    const key = `${provider.id}\0${provider.issuer}\0${provider.clientId}`;
    let config = configs.get(key);
    if (!config) {
      config = client.discovery(new URL(provider.issuer), provider.clientId, provider.clientSecret, undefined, {
        ...(isLocalHttp(provider.issuer) ? { execute: [client.allowInsecureRequests] } : {}),
      });
      config.catch(() => configs.delete(key));
      configs.set(key, config);
    }
    return config;
  }

  return {
    async authorizationUrl(provider, redirectUri, checks, extra = {}) {
      const config = await configFor(provider);
      return client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: provider.scopes.join(' '),
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
        ...extra,
      });
    },

    async finish(provider, callbackUrl, checks) {
      const config = await configFor(provider);
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('the provider returned no ID token');
      return claims;
    },
  };
}
