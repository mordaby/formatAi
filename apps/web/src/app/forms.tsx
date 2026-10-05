// What the three public forms (business lead, paid waitlist, feedback) share (SPEC 16.1 screen 7; v13 M4): labelled fields with their hint and
// error wired up for assistive technology, the checks (the SAME ones the API runs: `@formatai/shared` `checkLead` / `checkWaitlist` /
// `checkFeedback`, so a cap can never differ), the Turnstile token, and what the server's refusal says.
//
// WCAG: every field has a visible label (and says when it is optional), a hint and an error are tied to the field with `aria-describedby`,
// an invalid field has `aria-invalid`, the first invalid field takes the focus on submit, and the error summary is a live alert.
import type { ContactCheck, ContactField, ContactProblem } from '@formatai/shared';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { isApiError } from '../api';
import { flowErrorText } from '../flow/errors';
import { useI18n } from '../i18n';
import { useFormTurnstile, type FormTurnstile } from './FormTurnstile';
import { useMe } from './Me';

export interface TextFieldProps {
  name: ContactField;
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  type?: 'text' | 'email';
  multiline?: boolean;
  rows?: number;
  hint?: ReactNode;
  error?: string | undefined;
  autoComplete?: string;
  maxLength: number;
}

/** A labelled field. Optional fields say so in the label; the error and the hint are read with the field. */
export function TextField({ name, label, value, onChange, required = false, type = 'text', multiline = false, rows = 5, hint, error, autoComplete, maxLength }: TextFieldProps) {
  const { t } = useI18n();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    name,
    className: multiline ? 'input input--area' : 'input',
    value,
    // dir="auto": a Hebrew name or message reads right-to-left in an English page and the other way round; an email is always left-to-right.
    dir: type === 'email' ? ('ltr' as const) : ('auto' as const),
    'aria-required': required || undefined,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': describedBy,
    autoComplete,
    // (a little over the cap on purpose: the checks, not the browser, say what is too long, so the message is ours and in both languages)
    maxLength: maxLength * 2,
  };
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? null : <span className="field__optional"> {t('form.optional')}</span>}
      </label>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={type} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type FormStatus = 'idle' | 'sending' | 'sent';

export interface UseContactFormOptions<V extends Record<string, string>> {
  initial: V;
  /** The same check the API runs. */
  check(values: V, page: string): ContactCheck<unknown>;
  /** The character cap of a field (for "Use at most N characters"). */
  maxOf(field: ContactField): number;
  /** Sends the checked values. A rejected promise is the failure shown in the form. */
  send(values: V, ctx: { page: string; token: string | undefined }): Promise<void>;
}

export interface ContactForm<V extends Record<string, string>> {
  values: V;
  setValue(name: keyof V & string, value: string): void;
  /** What is wrong with each field, in words (after a submit). */
  errors: Partial<Record<ContactField, string>>;
  status: FormStatus;
  /** What the server (or the network) said, when the send failed. */
  failure: string | null;
  submit(e: FormEvent<HTMLFormElement>): void;
  formRef: RefObject<HTMLFormElement | null>;
  turnstile: FormTurnstile;
  /** Back to an empty form (the thank-you's "send another"). */
  reset(): void;
}

/** One field's problem, in words. */
export function fieldErrorText(t: ReturnType<typeof useI18n>['t'], field: ContactField, problem: ContactProblem, max: number): string {
  if (problem === 'tooLong') return t('form.err.tooLong', { max: new Intl.NumberFormat().format(max) });
  if (field === 'email' && problem === 'invalid') return t('form.err.email');
  return t('form.err.required');
}

export function useContactForm<V extends Record<string, string>>(opts: UseContactFormOptions<V>): ContactForm<V> {
  const i18n = useI18n();
  const { t } = i18n;
  const me = useMe();
  const { pathname } = useLocation();
  const [values, setValues] = useState<V>(opts.initial);
  const [errors, setErrors] = useState<Partial<Record<ContactField, string>>>({});
  const [status, setStatus] = useState<FormStatus>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [focusFirst, setFocusFirst] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  // A signed-in user passed a sign-in, so the API asks them for no token: no widget, no Cloudflare script (and none while that is still being found out).
  const turnstile = useFormTurnstile(me.status === 'ready' && me.user === null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The first field that is wrong takes the focus (after the error has been drawn).
  useEffect(() => {
    if (focusFirst === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusFirst]);

  const setValue = useCallback((name: keyof V & string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name as ContactField] ? { ...e, [name]: undefined } : e));
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (status === 'sending') return;
    setFailure(null);
    const checked = optsRef.current.check(values, pathname);
    if (!checked.ok) {
      setErrors({ [checked.field]: fieldErrorText(t, checked.field, checked.problem, optsRef.current.maxOf(checked.field)) });
      setFocusFirst((n) => n + 1);
      return;
    }
    setErrors({});
    setStatus('sending');
    void (async () => {
      try {
        const token = await turnstile.getToken();
        await optsRef.current.send(values, { page: pathname, token });
        if (mounted.current) setStatus('sent');
      } catch (err) {
        if (!mounted.current) return;
        setStatus('idle');
        setFailure(
          isApiError(err)
            ? flowErrorText(i18n, { kind: 'api', code: err.code, limit: err.limit, retryAfterSec: err.retryAfterSec })
            : t('error.unexpected'),
        );
      }
    })();
  };

  const reset = useCallback(() => {
    setValues(optsRef.current.initial);
    setErrors({});
    setFailure(null);
    setStatus('idle');
  }, []);

  return { values, setValue, errors, status, failure, submit, formRef, turnstile, reset };
}
