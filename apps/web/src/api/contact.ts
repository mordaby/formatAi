// The public forms' half of the API client (SPEC 16.1 screen 7, 11, 13): the business lead form, the paid waitlist and feedback.
// Every body is a few typed lines of text plus the page path - never a file, a rule or a cell (SPEC 2/15).
import type { ContactResponse, FeedbackRequest, LeadRequest, WaitlistRequest } from '@formatai/shared';
import type { HttpRequest } from './http';

export interface ContactApi {
  /** POST /api/leads: the "For business" form. */
  lead(body: LeadRequest, signal?: AbortSignal): Promise<void>;
  /** POST /api/waitlist: "Join the paid waitlist". */
  waitlist(body: WaitlistRequest, signal?: AbortSignal): Promise<void>;
  /** POST /api/feedback. */
  feedback(body: FeedbackRequest, signal?: AbortSignal): Promise<void>;
}

export function createContactApi(request: HttpRequest): ContactApi {
  return {
    lead: async (body, signal) => void (await request<ContactResponse>('POST', '/api/leads', body, signal)),
    waitlist: async (body, signal) => void (await request<ContactResponse>('POST', '/api/waitlist', body, signal)),
    feedback: async (body, signal) => void (await request<ContactResponse>('POST', '/api/feedback', body, signal)),
  };
}
