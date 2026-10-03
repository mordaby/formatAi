// `returnTo` is where the browser lands after sign-in. It must be a same-site relative path, or the
// sign-in endpoints become an open redirect (a phishing link on our own domain).
const BASE = 'http://return-to.invalid';

/**
 * The path (with its query) when `raw` is a relative path on this site, else `/`.
 * Rejected: absolute URLs, protocol-relative `//host`, backslash tricks (`/\host`), control characters
 * and anything that resolves to another origin. The URL is re-serialised, so what is returned is normalised.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return '/';
  }
  if (url.origin !== BASE) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Normalisation can turn "/..//evil.example" into "//evil.example", a network-path reference to another host.
  return path.startsWith('//') ? '/' : path;
}

/** `returnTo` on the web app, with one extra query parameter (a result code: `authError` or `linked`). */
export function redirectTarget(webOrigin: string, returnTo: string, param?: [name: string, value: string]): string {
  const url = new URL(safeReturnTo(returnTo), webOrigin);
  // Whatever happened above, never leave the web app.
  if (url.origin !== new URL(webOrigin).origin) return new URL('/', webOrigin).toString();
  if (param) url.searchParams.set(param[0], param[1]);
  return url.toString();
}
