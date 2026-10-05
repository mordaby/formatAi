import { checkFeedback, limits } from '@formatai/shared';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useServices } from '../services';
import { Button, Dialog, InlineMessage } from '../ui';
import { TextField, useContactForm } from './forms';
import { useMe } from './Me';
import { SentNotice } from './SentNotice';

/** A left-to-right address (/formats) inside a right-to-left sentence keeps its slashes in place when it is isolated (U+2066 ... U+2069). */
const isolate = (text: string): string => String.fromCharCode(0x2066) + text + String.fromCharCode(0x2069);

interface FeedbackApi {
  /** Opens the feedback form (a dialog) over whatever page is showing. */
  open(): void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside <FeedbackProvider>');
  return ctx;
}

/**
 * The footer's (and the account menu's) "Feedback" (v13 M4): a short form in a dialog - a message, an optional email, and the path of the page
 * it was sent from. NEVER file data or rules (the body has no field for them). Stored in `feedback`; a visitor passes Turnstile, everyone is
 * rate-limited.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const api = useMemo<FeedbackApi>(() => ({ open: () => setOpen(true) }), []);
  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <Dialog open={open} onClose={() => setOpen(false)} title={t('feedback.title')}>
        <FeedbackForm onClose={() => setOpen(false)} />
      </Dialog>
    </FeedbackContext.Provider>
  );
}

function FeedbackForm({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { api } = useServices();
  const { user } = useMe();
  const { pathname } = useLocation();
  const form = useContactForm({
    initial: { message: '', email: '' },
    check: (v, page) => checkFeedback({ ...v, page }),
    maxOf: (field) => (field === 'email' ? limits.contact.emailMaxChars : limits.contact.feedbackMessageMaxChars),
    send: (v, { page, token }) =>
      api.contact.feedback({ message: v.message, ...(v.email.trim() ? { email: v.email } : {}), page, ...(token ? { turnstileToken: token } : {}) }),
  });

  // A signed-in user's address is a good default for "write back to me" - but only if they have not typed anything there.
  const { setValue } = form;
  const known = user?.email;
  useEffect(() => {
    if (known) setValue('email', known);
  }, [known, setValue]);

  if (form.status === 'sent') {
    return (
      <>
        <SentNotice>{t('feedback.done')}</SentNotice>
        <div className="dialog__actions">
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <form className="form" ref={form.formRef} onSubmit={form.submit} noValidate>
      <p className="muted">{t('feedback.lead')}</p>
      <TextField
        name="message"
        label={t('feedback.message')}
        required
        multiline
        rows={5}
        maxLength={limits.contact.feedbackMessageMaxChars}
        value={form.values.message}
        onChange={(v) => form.setValue('message', v)}
        error={form.errors.message}
      />
      <TextField
        name="email"
        type="email"
        label={t('feedback.email')}
        hint={t('feedback.emailHint')}
        autoComplete="email"
        maxLength={limits.contact.emailMaxChars}
        value={form.values.email}
        onChange={(v) => form.setValue('email', v)}
        error={form.errors.email}
      />
      <p className="muted">{t('feedback.page', { page: isolate(pathname) })}</p>
      {form.turnstile.on ? <div className="turnstile" ref={form.turnstile.boxRef} data-turnstile="on" /> : null}
      {form.failure ? <InlineMessage tone="error">{form.failure}</InlineMessage> : null}
      <div className="dialog__actions">
        <Button type="submit" variant="primary" loading={form.status === 'sending'}>
          {form.status === 'sending' ? t('form.sending') : t('feedback.send')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}
