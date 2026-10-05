import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useOptionalTurnstile } from './Turnstile';
import { TurnstileController } from './turnstileController';

export interface FormTurnstile {
  /** Where the widget lives: put it on an element inside the form. Empty, and invisible, unless Cloudflare asks the visitor for something. */
  boxRef: (el: HTMLDivElement | null) => void;
  /** True when this form has a widget (Turnstile is on and the visitor is not signed in): render the box only then. */
  on: boolean;
  /** A fresh token for one submit; `undefined` when there is no widget or no token came in time (the API then answers `turnstileFailed`). */
  getToken(): Promise<string | undefined>;
}

/**
 * A Turnstile widget of the form's own (SPEC 9.5, 16.1 screen 7). The forms (business lead, paid waitlist, feedback) can be open at the same
 * time as each other, and the shared controller handles one widget, so each form makes its own `TurnstileController` - Cloudflare's script
 * is loaded once for all of them, and only when a form that needs it is on screen. `enabled: false` (a signed-in user) loads nothing: the
 * API asks only visitors for a token.
 */
export function useFormTurnstile(enabled: boolean): FormTurnstile {
  const turnstile = useOptionalTurnstile();
  const siteKey = turnstile?.siteKey;
  const sessionKnown = turnstile?.sessionKnown;
  const { lang } = useI18n();
  const langRef = useRef<string>(lang);
  langRef.current = lang;

  const controller = useMemo(() => (enabled && siteKey ? new TurnstileController({ siteKey, getLanguage: () => langRef.current }) : undefined), [enabled, siteKey]);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!controller || !box) return;
    return controller.attach(box);
  }, [controller, box]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!enabled) return undefined;
    await sessionKnown?.();
    return controllerRef.current?.getToken();
  }, [enabled, sessionKnown]);

  return { boxRef: setBox, on: controller !== undefined, getToken };
}
