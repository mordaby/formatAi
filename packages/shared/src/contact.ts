// The public forms (SPEC 16.1 screen 7, 13; v13 M4): the business lead form, the paid waitlist and feedback. One set of
// checks used by the API (which decides) and by the web (which says what to fix before anything is sent), so the two can
// never disagree about a cap. Pure and dependency-free: the same module runs in the browser and on the server.
//
// What these forms may carry is deliberately small: contact details and free text typed into the form, and the page path.
// NEVER a file name, a rule or a cell value (SPEC 15) - the page path is a pathname only (no query, no fragment).
import { LIMIT_CODES, type LimitCode } from './codes';
import { limits } from './config/limits';

/** Where the waitlist form was opened from: the limit that was hit (SPEC 11 `upgrade_intent { trigger }`), the batch hint, or nothing in particular. */
export const WAITLIST_TRIGGERS = [...LIMIT_CODES, 'batch', 'other'] as const;
export type WaitlistTrigger = LimitCode | 'batch' | 'other';

export type ContactField = 'name' | 'email' | 'company' | 'message' | 'page' | 'trigger';
export type ContactProblem = 'required' | 'tooLong' | 'invalid';

export type ContactCheck<T> = { ok: true; value: T } | { ok: false; field: ContactField; problem: ContactProblem };

/** POST /api/leads body (the "For business" form). `turnstileToken`: required for a visitor when Turnstile is configured. */
export interface LeadRequest {
  name: string;
  email: string;
  company?: string;
  message?: string;
  page: string;
  turnstileToken?: string;
}

/** POST /api/waitlist body (the "Join the paid waitlist" form). */
export interface WaitlistRequest {
  email: string;
  message?: string;
  trigger?: WaitlistTrigger;
  page: string;
  turnstileToken?: string;
}

/** POST /api/feedback body. */
export interface FeedbackRequest {
  message: string;
  email?: string;
  page: string;
  turnstileToken?: string;
}

/** Every form answers this when it was stored. */
export interface ContactResponse {
  ok: true;
}

/** What the checks keep of a request: only these fields, trimmed - nothing else is ever stored. */
export type LeadFields = Omit<LeadRequest, 'turnstileToken'>;
export type WaitlistFields = Omit<WaitlistRequest, 'turnstileToken'> & { trigger: WaitlistTrigger };
export type FeedbackFields = Omit<FeedbackRequest, 'turnstileToken'>;

// Control characters (but a tab or a line break inside a message) never belong in a form's text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_ONE_LINE = /[\u0000-\u001f\u007f-\u009f]/g;

const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]{2,}$/;
const PAGE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

function charCount(text: string): number {
  return Array.from(text).length;
}

type Read = { ok: true; value: string | undefined } | { ok: false; problem: ContactProblem };

/** A string field: trimmed, control characters dropped, and measured against its cap. `undefined` when absent or blank. */
function readText(raw: unknown, max: number, opts: { multiline?: boolean } = {}): Read {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, problem: 'invalid' };
  const text = (opts.multiline ? raw.replace(/\r\n?/g, '\n').replace(CONTROL, '') : raw.replace(CONTROL_ONE_LINE, ' ')).trim();
  if (text === '') return { ok: true, value: undefined };
  if (charCount(text) > max) return { ok: false, problem: 'tooLong' };
  return { ok: true, value: text };
}

function fail<T>(field: ContactField, problem: ContactProblem): ContactCheck<T> {
  return { ok: false, field, problem };
}

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/** A required field: it must be there (not blank) and within its cap. */
function required(read: Read, field: ContactField): { problem: ContactCheck<never> } | { value: string } {
  if (!read.ok) return { problem: fail(field, read.problem) };
  if (read.value === undefined) return { problem: fail(field, 'required') };
  return { value: read.value };
}

function checkEmail(raw: unknown, mandatory: boolean): { problem: ContactCheck<never> } | { value: string | undefined } {
  const read = readText(raw, limits.contact.emailMaxChars);
  if (!read.ok) return { problem: fail('email', read.problem) };
  if (read.value === undefined) return mandatory ? { problem: fail('email', 'required') } : { value: undefined };
  const email = read.value.toLowerCase();
  if (!EMAIL.test(email)) return { problem: fail('email', 'invalid') };
  return { value: email };
}

/** The page a form was sent from: a pathname (a query or a fragment, if one was sent, is cut off and never kept). */
export function checkPage(raw: unknown): ContactCheck<string> {
  if (typeof raw !== 'string') return fail('page', raw === undefined ? 'required' : 'invalid');
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (path === '') return fail('page', 'required');
  if (charCount(path) > limits.contact.pageMaxChars) return fail('page', 'tooLong');
  if (!PAGE.test(path)) return fail('page', 'invalid');
  return { ok: true, value: path };
}

/** The business lead form: a name and an email; a company and a message when given. */
export function checkLead(body: unknown): ContactCheck<LeadFields> {
  if (!isObject(body)) return fail('name', 'required');
  const name = required(readText(body.name, limits.contact.nameMaxChars), 'name');
  if ('problem' in name) return name.problem;
  const email = checkEmail(body.email, true);
  if ('problem' in email) return email.problem;
  const company = readText(body.company, limits.contact.companyMaxChars);
  if (!company.ok) return fail('company', company.problem);
  const message = readText(body.message, limits.contact.leadMessageMaxChars, { multiline: true });
  if (!message.ok) return fail('message', message.problem);
  const page = checkPage(body.page);
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      name: name.value,
      email: email.value!,
      ...(company.value !== undefined ? { company: company.value } : {}),
      ...(message.value !== undefined ? { message: message.value } : {}),
      page: page.value,
    },
  };
}

/** The paid waitlist: an email, and a message when given. */
export function checkWaitlist(body: unknown): ContactCheck<WaitlistFields> {
  if (!isObject(body)) return fail('email', 'required');
  const email = checkEmail(body.email, true);
  if ('problem' in email) return email.problem;
  const message = readText(body.message, limits.contact.waitlistMessageMaxChars, { multiline: true });
  if (!message.ok) return fail('message', message.problem);
  let trigger: WaitlistTrigger = 'other';
  if (body.trigger !== undefined) {
    if (typeof body.trigger !== 'string' || !(WAITLIST_TRIGGERS as readonly string[]).includes(body.trigger)) return fail('trigger', 'invalid');
    trigger = body.trigger as WaitlistTrigger;
  }
  const page = checkPage(body.page);
  if (!page.ok) return page;
  return {
    ok: true,
    value: { email: email.value!, ...(message.value !== undefined ? { message: message.value } : {}), trigger, page: page.value },
  };
}

/** Feedback: a message; an email only when the visitor wants an answer. */
export function checkFeedback(body: unknown): ContactCheck<FeedbackFields> {
  if (!isObject(body)) return fail('message', 'required');
  const message = required(readText(body.message, limits.contact.feedbackMessageMaxChars, { multiline: true }), 'message');
  if ('problem' in message) return message.problem;
  const email = checkEmail(body.email, false);
  if ('problem' in email) return email.problem;
  const page = checkPage(body.page);
  if (!page.ok) return page;
  return { ok: true, value: { message: message.value, ...(email.value !== undefined ? { email: email.value } : {}), page: page.value } };
}
