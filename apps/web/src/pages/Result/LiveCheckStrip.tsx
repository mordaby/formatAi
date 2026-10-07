// The live check strip (SPEC 8.11 "Live check"): "Matches X of Y rows in your example", updated about 150 ms after every
// change, with what differs in the layout and the problems the static checks found, in plain words. When the number changes
// the strip is highlighted for a moment, so a change is seen to have landed; and a check that only saw a sample of a big
// example says so and offers to check all rows.
//
// The static checks' problems are said in the UI's language (`problemText`); only the checker's own words a sentence quotes stay English, and
// are marked so. They are listed as they were until the checks have answered for the newest edit (no flicker), and a polite live region
// that is always there says them - so a screen reader hears the list when it CHANGES, not again after every edit (C9).
import type { LayoutProblemCode } from '@formatai/engine';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ExplainedProblem, UseLiveCheck } from '../../editor';
import { useI18n, type I18n, type MessageKey } from '../../i18n';
import { Button, Icon, Spinner } from '../../ui';

/** Where `detail` goes in a sentence, so the checker's (English) words can be marked as such. */
const DETAIL = '\u0000';

/**
 * A static-check problem in the UI's language: the place, then the sentence. The checker's own words a sentence quotes (English) come back
 * marked `lang="en"`; `plain` gives the same as one string (for the live region).
 */
export function problemText(i18n: Pick<I18n, 't'>, p: ExplainedProblem): { node: ReactNode; plain: string } {
  const { t } = i18n;
  const words = (w: ExplainedProblem['place']): Record<string, string | number> => ({
    ...w.params,
    ...Object.fromEntries(Object.entries(w.terms ?? {}).map(([k, key]) => [k, t(key)])),
  });
  const where = t(p.place.key, words(p.place));
  const detail = p.message.detail;
  const text = t(p.message.key, { ...words(p.message), where, ...(detail !== undefined ? { detail: DETAIL } : {}) });
  if (detail === undefined) return { node: text, plain: text };
  const parts = text.split(DETAIL);
  return {
    node: parts.map((part, i) => (
      <Fragment key={i}>
        {i > 0 ? (
          <span lang="en" dir="ltr">
            {detail}
          </span>
        ) : null}
        {part}
      </Fragment>
    )),
    plain: parts.join(detail),
  };
}

const LAYOUT_TEXT: Record<LayoutProblemCode, MessageKey> = {
  runFailed: 'check.layout.runFailed',
  unalignedRows: 'check.layout.unalignedRows',
  rowCount: 'check.layout.rowCount',
  rowOrder: 'check.layout.rowOrder',
  fileSettings: 'check.layout.fileSettings',
  titleRow: 'check.layout.titleRow',
  headerRow: 'check.layout.headerRow',
  blankRow: 'check.layout.blankRow',
  summaryRow: 'check.layout.summaryRow',
};

/** How long the strip stays highlighted after its number changes. */
export const STRIP_HIGHLIGHT_MS = 1600;

/** True for a moment after `key` changes (never for the first value, nor while there is none). */
function useChangeFlash(key: string | null): boolean {
  const [flash, setFlash] = useState(false);
  const last = useRef<string | null>(null);
  useEffect(() => {
    const before = last.current;
    if (key !== null) last.current = key;
    if (key === null || before === null || before === key) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), STRIP_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return flash;
}

export function LiveCheckStrip({ check, noExampleText }: { check: UseLiveCheck; /** What to say when there is no example (default: it is not in memory any more). */ noExampleText?: string | undefined }) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  // The problems as the static checks last answered them: an edit does not empty the list while its checks run.
  const held = useRef<ExplainedProblem[]>([]);
  if (check.problemsChecked) held.current = check.problems;
  const problems = held.current.map((p) => problemText(i18n, p));
  // What the live region says (it changes only when the list does: an unchanged list is not said again).
  const announced = problems.length > 0 ? [t('check.problems', { n: problems.length }), ...problems.map((p) => p.plain)].join(' ') : '';
  const s = check.state;
  const live = s.live;
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
  const changed = useChangeFlash(live ? `${live.matched}/${live.total}/${live.differences}/${live.partial ? 'sample' : 'all'}` : null);

  let tone: 'ok' | 'diff' | 'busy' | 'quiet' = 'busy';
  let text: string;
  let action: 'apply' | 'all' | null = null;
  if (s.status === 'noExample') {
    tone = 'quiet';
    text = noExampleText ?? t('check.noExample');
  } else if (!live && s.status === 'error') {
    tone = 'diff';
    text = t('check.failed');
    action = 'apply';
  } else if (!live) {
    text = t('check.checking');
  } else if (live.partial) {
    // A big example is checked live on a sample: the numbers are the sample's, and one button checks every row.
    tone = live.matched < live.total ? 'diff' : 'quiet';
    text = t('check.sample', { n: number(live.checkedInputRows), matched: number(live.matched), total: number(live.total) });
    action = 'all';
  } else {
    tone = live.verified ? 'ok' : 'diff';
    text = t('check.matches', { matched: number(live.matched), total: number(live.total) });
  }
  if (live && !live.partial && s.status === 'error') action = 'apply';

  const codes = live ? [...new Set(live.layoutIssues.map((i) => i.code))].slice(0, 4) : [];
  const more = live ? new Set(live.layoutIssues.map((i) => i.code)).size - codes.length : 0;

  return (
    <section className="strip" aria-label={t('check.label')} data-tone={tone} data-changed={changed || undefined} data-sample={live?.partial || undefined}>
      <div className="strip__main">
        <span className="strip__icon" aria-hidden="true">
          {tone === 'ok' ? <Icon name="check" size={18} /> : tone === 'diff' ? <Icon name="alert" size={18} /> : tone === 'busy' ? <Spinner size={18} /> : <Icon name="info" size={18} />}
        </span>
        <p className="strip__text tabular" role="status" aria-live="polite" data-testid="live-check-text">
          {text}
          {check.stale && live && <span className="visually-hidden"> {t('check.updating')}</span>}
        </p>
        {check.stale && live && <Spinner size={14} />}
        {action && (
          <Button variant="secondary" size="sm" loading={s.applying} onClick={() => void check.apply()}>
            {t(action === 'all' ? 'check.checkAll' : 'check.apply')}
          </Button>
        )}
      </div>
      {codes.length > 0 && (
        <ul className="strip__list">
          {codes.map((c) => (
            <li key={c}>
              <Icon name="alert" size={14} />
              <span>{t(LAYOUT_TEXT[c])}</span>
            </li>
          ))}
          {more > 0 && <li className="muted">{t('check.moreLayout', { n: more })}</li>}
        </ul>
      )}
      {problems.length > 0 && (
        <div className="strip__problems" data-testid="check-problems">
          <p className="strip__problemsTitle">{t('check.problems', { n: problems.length })}</p>
          <ul className="strip__list">
            {problems.map((p, i) => (
              <li key={i}>
                <Icon name="alert" size={14} />
                <span>{p.node}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="visually-hidden" aria-live="polite" data-testid="check-problems-live">
        {announced}
      </p>
    </section>
  );
}
