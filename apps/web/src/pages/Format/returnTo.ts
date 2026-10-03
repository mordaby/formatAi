// "Back to converting": the Convert screen opens a source's rules editor with `?returnTo=<its own address>` so the editor can
// send the person back. The value comes from the address bar, so it is only ever used when it is a same-site relative path.

const BACKSLASH = String.fromCharCode(92);

/** `/convert?resume=1` -> itself; anything that could leave the site (`https://...`, `//host`, a backslash, `javascript:`) -> null. */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 500) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes(BACKSLASH)) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null; // control characters
  }
  return raw;
}
