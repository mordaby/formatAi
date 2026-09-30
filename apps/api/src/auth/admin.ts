// Who is an admin (SPEC 12): a verified Google email in ADMIN_EMAILS, or a Microsoft object id in
// MICROSOFT_ADMIN_OIDS. Evaluated from the user's identities on every request, so removing someone from the
// list takes effect at once and nothing about "admin" is stored on the user.
import type { Env } from '../env.js';
import type { UserIdentity } from '../models.js';

export interface AdminConfig {
  /** Lower-cased. */
  emails: ReadonlySet<string>;
  /** Lower-cased `oid` or `tid:oid`. */
  microsoftOids: ReadonlySet<string>;
}

function list(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  );
}

export function loadAdminConfig(env: Env): AdminConfig {
  return { emails: list(env.ADMIN_EMAILS), microsoftOids: list(env.MICROSOFT_ADMIN_OIDS) };
}

export function isAdmin(identities: readonly UserIdentity[], config: AdminConfig): boolean {
  return identities.some((i) => {
    if (i.provider === 'google') {
      // Microsoft's email claim is not verified, and Google's only counts when Google says it is.
      return i.emailVerified && i.email !== '' && config.emails.has(i.email.toLowerCase());
    }
    if (i.provider === 'microsoft') {
      const oid = i.subject.toLowerCase();
      return config.microsoftOids.has(oid) || (i.tenantId !== undefined && config.microsoftOids.has(`${i.tenantId.toLowerCase()}:${oid}`));
    }
    return false;
  });
}
