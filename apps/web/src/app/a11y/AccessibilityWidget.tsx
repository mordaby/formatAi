import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, Switch } from '../../ui';
import { useA11y } from './A11y';
import type { A11yPrefs, TextSize } from './prefs';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `box`, in order: a group of radio buttons is one stop (the checked one, or the first when none is). */
export function tabStops(box: HTMLElement): HTMLElement[] {
  const all = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
    const group = all.filter((o): o is HTMLInputElement => o instanceof HTMLInputElement && o.type === 'radio' && o.name === el.name);
    const stop = group.find((o) => o.checked) ?? group[0];
    return el === stop;
  });
}

const SIZES: readonly { size: TextSize; label: MessageKey }[] = [
  { size: 0, label: 'a11y.textSize.normal' },
  { size: 1, label: 'a11y.textSize.large' },
  { size: 2, label: 'a11y.textSize.larger' },
];

const TOGGLES: readonly { key: Exclude<keyof A11yPrefs, 'textSize'>; label: MessageKey }[] = [
  { key: 'contrast', label: 'a11y.contrast' },
  { key: 'links', label: 'a11y.links' },
  { key: 'font', label: 'a11y.font' },
  { key: 'motion', label: 'a11y.motion' },
  { key: 'focus', label: 'a11y.focus' },
  { key: 'spacing', label: 'a11y.spacing' },
];

/** The universal-access mark: a person inside a ring (a line icon on the 20px grid like the rest of them). */
function AccessMark() {
  return (
    <svg className="icon" width="26" height="26" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.6" />
      <circle cx="10" cy="6.3" r="0.8" fill="currentColor" />
      <path d="M5.8 8.5l4.2.8 4.2-.8M10 9.3v3M8.4 14.6L10 12.3l1.6 2.3" />
    </svg>
  );
}

/**
 * The floating accessibility button and its panel (IS 5568 / WCAG 2.1 AA; owner request): text size, high contrast, underlined links, a readable
 * font, no animations, a strong focus ring, spacing, a reset and the link to the statement. It sits at the inline-end bottom corner of every
 * page - left in Hebrew, right in English (logical properties) - and the page keeps room under its content so it never covers any.
 *
 * Keyboard: the button is in the tab order and says what it does; the panel is a dialog that takes the focus, keeps it (Tab wraps, Shift+Tab
 * too), closes with Escape and gives the focus back to the button.
 */
export function AccessibilityWidget() {
  const { t } = useI18n();
  const { prefs, set, reset } = useA11y();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const close = useCallback((giveFocusBack: boolean) => {
    setOpen(false);
    if (giveFocusBack) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const box = panel.current;
    if (!box) return;
    box.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = tabStops(box);
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === box || !box.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target;
      if (target instanceof Node && !box.contains(target) && !button.current?.contains(target)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  return (
    <div className="a11y">
      <button
        type="button"
        className="a11y__button"
        ref={button}
        aria-label={t('a11y.open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <AccessMark />
      </button>
      {open && (
        <div className="a11y__panel" id={panelId} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
          <div className="a11y__head">
            <h2 id={titleId}>{t('a11y.title')}</h2>
            <Button variant="ghost" size="sm" icon="close" aria-label={t('common.close')} onClick={() => close(true)} />
          </div>

          <fieldset className="a11y__sizes">
            <legend>{t('a11y.textSize')}</legend>
            <div className="a11y__segments">
              {SIZES.map(({ size, label }) => (
                <label className="a11y__size" key={size} data-size={size}>
                  <input type="radio" className="a11y__radio" name="a11y-text-size" checked={prefs.textSize === size} onChange={() => set('textSize', size)} />
                  <span className="a11y__size-label">{t(label)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="a11y__toggles">
            {TOGGLES.map(({ key, label }) => (
              <Switch key={key} checked={prefs[key]} onChange={(on) => set(key, on)} label={t(label)} />
            ))}
          </div>

          <div className="a11y__foot">
            <Button variant="secondary" size="sm" onClick={reset}>
              {t('a11y.reset')}
            </Button>
            <Link to="/accessibility" onClick={() => close(false)}>
              {t('a11y.statement')}
            </Link>
          </div>
          <p className="muted">{t('a11y.saved')}</p>
        </div>
      )}
    </div>
  );
}
