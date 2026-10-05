import { describe, expect, it } from 'vitest';
import { checkFeedback, checkLead, checkPage, checkWaitlist, limits, WAITLIST_TRIGGERS } from '../src/index';

const lead = { name: 'Dana Levi', email: 'Dana@Example.com', page: '/business' };

describe('checkPage', () => {
  it('keeps a pathname and cuts a query or a fragment off', () => {
    expect(checkPage('/formats/65f0c2a1b3d4e5f607182930')).toEqual({ ok: true, value: '/formats/65f0c2a1b3d4e5f607182930' });
    expect(checkPage('/business?x=1#top')).toEqual({ ok: true, value: '/business' });
    expect(checkPage('/')).toEqual({ ok: true, value: '/' });
  });
  it.each([
    [undefined, 'required'],
    ['', 'required'],
    ['?only=query', 'required'],
    ['business', 'invalid'],
    ['/has space', 'invalid'],
    ['//evil.example', 'invalid'],
    [42, 'invalid'],
    ['/' + 'a'.repeat(limits.contact.pageMaxChars), 'tooLong'],
  ])('refuses %j', (raw, problem) => {
    expect(checkPage(raw)).toEqual({ ok: false, field: 'page', problem });
  });
});

describe('checkLead', () => {
  it('trims, lower-cases the email and keeps only the lead fields', () => {
    const r = checkLead({ ...lead, name: '  Dana Levi ', company: ' Acme ', message: 'Hi\r\nthere', extra: 'dropped', ip: '1.2.3.4', turnstileToken: 'x' });
    expect(r).toEqual({ ok: true, value: { name: 'Dana Levi', email: 'dana@example.com', company: 'Acme', message: 'Hi\nthere', page: '/business' } });
  });

  it('leaves out a company or a message that is blank', () => {
    const r = checkLead({ ...lead, company: '   ', message: '' });
    expect(r).toEqual({ ok: true, value: { name: 'Dana Levi', email: 'dana@example.com', page: '/business' } });
  });

  it('needs a name, a valid email and a page', () => {
    expect(checkLead({ ...lead, name: ' ' })).toEqual({ ok: false, field: 'name', problem: 'required' });
    expect(checkLead({ ...lead, email: undefined })).toEqual({ ok: false, field: 'email', problem: 'required' });
    expect(checkLead({ ...lead, email: 'not an email' })).toEqual({ ok: false, field: 'email', problem: 'invalid' });
    expect(checkLead({ ...lead, email: 'a@b' })).toEqual({ ok: false, field: 'email', problem: 'invalid' });
    expect(checkLead({ ...lead, page: undefined })).toEqual({ ok: false, field: 'page', problem: 'required' });
    expect(checkLead(null)).toMatchObject({ ok: false });
    expect(checkLead([])).toMatchObject({ ok: false });
    expect(checkLead('text')).toMatchObject({ ok: false });
  });

  it('refuses a value that is not text', () => {
    expect(checkLead({ ...lead, name: 5 })).toEqual({ ok: false, field: 'name', problem: 'invalid' });
    expect(checkLead({ ...lead, company: { a: 1 } })).toEqual({ ok: false, field: 'company', problem: 'invalid' });
    expect(checkLead({ ...lead, message: ['x'] })).toEqual({ ok: false, field: 'message', problem: 'invalid' });
  });

  it('enforces every cap, counted in characters (a Hebrew letter is one)', () => {
    const c = limits.contact;
    expect(checkLead({ ...lead, name: 'א'.repeat(c.nameMaxChars) }).ok).toBe(true);
    expect(checkLead({ ...lead, name: 'א'.repeat(c.nameMaxChars + 1) })).toEqual({ ok: false, field: 'name', problem: 'tooLong' });
    expect(checkLead({ ...lead, email: `${'a'.repeat(c.emailMaxChars)}@example.com` })).toEqual({ ok: false, field: 'email', problem: 'tooLong' });
    expect(checkLead({ ...lead, company: 'c'.repeat(c.companyMaxChars + 1) })).toEqual({ ok: false, field: 'company', problem: 'tooLong' });
    expect(checkLead({ ...lead, message: 'm'.repeat(c.leadMessageMaxChars) }).ok).toBe(true);
    expect(checkLead({ ...lead, message: 'm'.repeat(c.leadMessageMaxChars + 1) })).toEqual({ ok: false, field: 'message', problem: 'tooLong' });
    // an emoji is one character, not two code units
    expect(checkLead({ ...lead, name: '😀'.repeat(c.nameMaxChars) }).ok).toBe(true);
  });

  it('drops control characters: a name stays on one line, a message keeps its line breaks', () => {
    const r = checkLead({ ...lead, name: 'Da\u0000na\nLevi', message: 'a\u0007b\nc\td' });
    expect(r).toMatchObject({ ok: true, value: { name: 'Da na Levi', message: 'ab\nc\td' } });
  });
});

describe('checkWaitlist', () => {
  it('needs an email and defaults the trigger to "other"', () => {
    expect(checkWaitlist({ email: 'a@b.co', page: '/formats' })).toEqual({ ok: true, value: { email: 'a@b.co', trigger: 'other', page: '/formats' } });
    expect(checkWaitlist({ page: '/formats' })).toEqual({ ok: false, field: 'email', problem: 'required' });
  });

  it('takes a known trigger (a limit code or "batch") and refuses any other', () => {
    for (const trigger of WAITLIST_TRIGGERS) expect(checkWaitlist({ email: 'a@b.co', page: '/', trigger })).toMatchObject({ ok: true, value: { trigger } });
    expect(checkWaitlist({ email: 'a@b.co', page: '/', trigger: 'savedFormats', message: ' more please ' })).toMatchObject({ ok: true, value: { trigger: 'savedFormats', message: 'more please' } });
    expect(checkWaitlist({ email: 'a@b.co', page: '/', trigger: 'drop table' })).toEqual({ ok: false, field: 'trigger', problem: 'invalid' });
    expect(checkWaitlist({ email: 'a@b.co', page: '/', trigger: 7 })).toEqual({ ok: false, field: 'trigger', problem: 'invalid' });
  });

  it('caps the message', () => {
    const over = 'm'.repeat(limits.contact.waitlistMessageMaxChars + 1);
    expect(checkWaitlist({ email: 'a@b.co', page: '/', message: over })).toEqual({ ok: false, field: 'message', problem: 'tooLong' });
  });
});

describe('checkFeedback', () => {
  it('needs a message; the email is optional but must be valid when given', () => {
    expect(checkFeedback({ message: 'Nice', page: '/' })).toEqual({ ok: true, value: { message: 'Nice', page: '/' } });
    expect(checkFeedback({ message: 'Nice', email: ' A@B.co ', page: '/' })).toEqual({ ok: true, value: { message: 'Nice', email: 'a@b.co', page: '/' } });
    expect(checkFeedback({ message: '  ', page: '/' })).toEqual({ ok: false, field: 'message', problem: 'required' });
    expect(checkFeedback({ message: 'Nice', email: 'nope', page: '/' })).toEqual({ ok: false, field: 'email', problem: 'invalid' });
    expect(checkFeedback({ message: 'x'.repeat(limits.contact.feedbackMessageMaxChars + 1), page: '/' })).toEqual({ ok: false, field: 'message', problem: 'tooLong' });
  });

  it('keeps nothing but message, email and page', () => {
    const r = checkFeedback({ message: 'Nice', page: '/x?y=1', rules: { secret: 1 }, rows: [[1, 2]], file: 'a.xlsx', userId: 'u1' });
    expect(r).toEqual({ ok: true, value: { message: 'Nice', page: '/x' } });
  });
});
