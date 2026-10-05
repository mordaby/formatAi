// The admin half of the API client (SPEC 14.2, M4): the overview, function requests, users and their tier, leads and feedback, the audit
// log. Every call needs an admin session: the server answers 401 / 403 to anyone else (`signInRequired` / `forbidden`), whatever the page
// shows. Counts, ids and codes only (see `adminApi.ts` in the shared package).
import type {
  AdminAuditEntry,
  AdminAuditResponse,
  AdminContact,
  AdminContactsResponse,
  AdminFunctionRequest,
  AdminFunctionRequestsResponse,
  AdminOverview,
  AdminPeriodDays,
  AdminUpdateFunctionRequestRequest,
  AdminUpdateFunctionRequestResponse,
  AdminUpdateUserRequest,
  AdminUpdateUserResponse,
  AdminUserRow,
  AdminUsersResponse,
} from '@formatai/shared';
import type { HttpRequest } from './http';

export interface AdminUsersQuery {
  /** An email or a name (a part of it). */
  q: string;
  page: number;
}

export interface AdminApi {
  /** GET /api/admin/overview?days= */
  overview(days: AdminPeriodDays, signal?: AbortSignal): Promise<AdminOverview>;
  /** GET /api/admin/function-requests */
  functionRequests(signal?: AbortSignal): Promise<AdminFunctionRequestsResponse>;
  /** PATCH /api/admin/function-requests/:id: "issue opened" (so it is not offered twice), or `new` again. */
  setFunctionRequestStatus(id: string, status: AdminUpdateFunctionRequestRequest['status']): Promise<AdminFunctionRequest>;
  /** GET /api/admin/users?q=&page= */
  users(query: AdminUsersQuery, signal?: AbortSignal): Promise<AdminUsersResponse>;
  /** PATCH /api/admin/users/:id: the tier and/or the limit overrides. Every change is in the audit log. */
  updateUser(id: string, body: AdminUpdateUserRequest): Promise<AdminUserRow>;
  /** GET /api/admin/contacts: leads and feedback, newest first. */
  contacts(signal?: AbortSignal): Promise<AdminContact[]>;
  /** GET /api/admin/audit */
  audit(signal?: AbortSignal): Promise<AdminAuditEntry[]>;
}

const enc = encodeURIComponent;

export function createAdminApi(request: HttpRequest): AdminApi {
  return {
    overview: (days, signal) => request<AdminOverview>('GET', `/api/admin/overview?days=${days}`, undefined, signal),
    functionRequests: (signal) => request<AdminFunctionRequestsResponse>('GET', '/api/admin/function-requests', undefined, signal),
    setFunctionRequestStatus: async (id, status) => {
      const body: AdminUpdateFunctionRequestRequest = { status };
      return (await request<AdminUpdateFunctionRequestResponse>('PATCH', `/api/admin/function-requests/${enc(id)}`, body)).request;
    },
    users: ({ q, page }, signal) => request<AdminUsersResponse>('GET', `/api/admin/users?q=${enc(q)}&page=${page}`, undefined, signal),
    updateUser: async (id, body) => (await request<AdminUpdateUserResponse>('PATCH', `/api/admin/users/${enc(id)}`, body)).user,
    contacts: async (signal) => (await request<AdminContactsResponse>('GET', '/api/admin/contacts', undefined, signal)).items,
    audit: async (signal) => (await request<AdminAuditResponse>('GET', '/api/admin/audit', undefined, signal)).entries,
  };
}
