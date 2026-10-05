import { checkWaitlist, limits, type WaitlistTrigger } from '@formatai/shared';
import { useEffect } from 'react';
import { useI18n } from '../i18n';
import { useServices } from '../services';
import { Button, InlineMessage } from '../ui';
import { TextField, useContactForm } from './forms';
import { useMe } from './Me';
import { SentNotice } from './SentNotice';

/**
 * "Join the paid waitlist" (SPEC 11 "Upgrade button", 13 `leads` kind `waitlist`): an email (filled in for a signed-in user) and an optional
 * message. `trigger` says which limit (or hint) opened it, so the owner sees what people ran into. There is no payment code in the MVP.
 */
export function WaitlistForm({ trigger }: { trigger: WaitlistTrigger }) {
  const { t } = useI18n();
  const { api } = useServices();
  const { user } = useMe();
  const form = useContactForm({
    initial: { email: user?.email ?? '', message: '' },
    check: (v, page) => checkWaitlist({ ...v, trigger, page }),
    maxOf: (field) => (field === 'email' ? limits.contact.emailMaxChars : limits.contact.waitlistMessageMaxChars),
    send: (v, { page, token }) =>
      api.contact.waitlist({ email: v.email, ...(v.message.trim() ? { message: v.message } : {}), trigger, page, ...(token ? { turnstileToken: token } : {}) }),
  });

  // The signed-in user's address arrives a moment after the page: fill it in while the field is still untouched.
  const { setValue } = form;
  const known = user?.email;
  useEffect(() => {
    if (known) setValue('email', known);
  }, [known, setValue]);

  if (form.status === 'sent') return <SentNotice>{t('waitlist.done', { email: form.values.email.trim().toLowerCase() })}</SentNotice>;

  return (
    <form className="form" ref={form.formRef} onSubmit={form.submit} noValidate>
      <TextField name="email" type="email" label={t('form.email')} required autoComplete="email" maxLength={limits.contact.emailMaxChars} value={form.values.email} onChange={(v) => form.setValue('email', v)} error={form.errors.email} />
      <TextField
        name="message"
        label={t('waitlist.message')}
        multiline
        rows={3}
        maxLength={limits.contact.waitlistMessageMaxChars}
        value={form.values.message}
        onChange={(v) => form.setValue('message', v)}
        error={form.errors.message}
      />
      {form.turnstile.on ? <div className="turnstile" ref={form.turnstile.boxRef} data-turnstile="on" /> : null}
      {form.failure ? <InlineMessage tone="error">{form.failure}</InlineMessage> : null}
      <div className="form__actions">
        <Button type="submit" variant="primary" loading={form.status === 'sending'}>
          {form.status === 'sending' ? t('form.sending') : t('waitlist.send')}
        </Button>
      </div>
    </form>
  );
}
