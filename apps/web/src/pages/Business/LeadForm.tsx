import { checkLead, limits } from '@formatai/shared';
import { Link } from 'react-router-dom';
import { useContactForm, TextField } from '../../app/forms';
import { SentNotice } from '../../app/SentNotice';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Button, InlineMessage } from '../../ui';

/**
 * The "For business" lead form (SPEC 16.1 screen 7): name and email (required), company and message. Sent to POST /api/leads (a Turnstile token
 * for a visitor, a rate limit for everyone) and stored in `leads` with `kind: 'lead'`. Then a thank-you takes its place.
 */
export function LeadForm() {
  const { t } = useI18n();
  const { api } = useServices();
  const form = useContactForm({
    initial: { name: '', email: '', company: '', message: '' },
    check: (v, page) => checkLead({ ...v, page }),
    maxOf: (field) =>
      field === 'name' ? limits.contact.nameMaxChars : field === 'email' ? limits.contact.emailMaxChars : field === 'company' ? limits.contact.companyMaxChars : limits.contact.leadMessageMaxChars,
    send: (v, { page, token }) =>
      api.contact.lead({
        name: v.name,
        email: v.email,
        ...(v.company.trim() ? { company: v.company } : {}),
        ...(v.message.trim() ? { message: v.message } : {}),
        page,
        ...(token ? { turnstileToken: token } : {}),
      }),
  });

  if (form.status === 'sent') {
    return (
      <div className="form">
        <SentNotice title={t('business.thanks.title')}>{t('business.thanks.text')}</SentNotice>
        <div>
          <Button variant="ghost" onClick={form.reset}>
            {t('business.thanks.again')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="form form--lead" ref={form.formRef} onSubmit={form.submit} noValidate>
      <div className="form__row">
        <TextField name="name" label={t('form.name')} required autoComplete="name" maxLength={limits.contact.nameMaxChars} value={form.values.name} onChange={(v) => form.setValue('name', v)} error={form.errors.name} />
        <TextField name="email" type="email" label={t('form.email')} required autoComplete="email" maxLength={limits.contact.emailMaxChars} value={form.values.email} onChange={(v) => form.setValue('email', v)} error={form.errors.email} />
      </div>
      <TextField name="company" label={t('form.company')} autoComplete="organization" maxLength={limits.contact.companyMaxChars} value={form.values.company} onChange={(v) => form.setValue('company', v)} error={form.errors.company} />
      <TextField
        name="message"
        label={t('business.contact.message')}
        multiline
        rows={5}
        maxLength={limits.contact.leadMessageMaxChars}
        value={form.values.message}
        onChange={(v) => form.setValue('message', v)}
        error={form.errors.message}
      />
      {form.turnstile.on ? <div className="turnstile" ref={form.turnstile.boxRef} data-turnstile="on" /> : null}
      {form.failure ? <InlineMessage tone="error">{form.failure}</InlineMessage> : null}
      <div className="form__actions">
        <Button type="submit" variant="primary" loading={form.status === 'sending'}>
          {form.status === 'sending' ? t('form.sending') : t('form.send')}
        </Button>
      </div>
      <p className="muted">
        {t('form.privacyNote')} <Link to="/privacy">{t('form.privacyLink')}</Link>
      </p>
    </form>
  );
}
