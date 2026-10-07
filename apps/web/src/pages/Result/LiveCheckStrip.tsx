// The live check strip (SPEC 8.11 "Live check"): "Matches X of Y rows in your example", updated about 150 ms after every
// change, with what differs in the layout and the problems the static checks found, in plain words. When the number changes
// the strip is highlighted for a moment, so a change is seen to have landed; and a check that only saw a sample of a big
// example says so and offers to check all rows.
import type { LayoutProblemCode } from '@formatai/engine';
import { useEffect, useRef, useState } from 'react';
import type { UseLiveCheck } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, Icon, Spinner } from '../../ui';

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
  const { t, lang } = useI18n();
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
      {check.problems.length > 0 && (
        <div className="strip__problems" role="alert">
          <p className="strip__problemsTitle">{t('check.problems', { n: check.problems.length })}</p>
          <ul className="strip__list">
            {check.problems.map((p, i) => (
              <li key={i} lang="en" dir="ltr">
                <Icon name="alert" size={14} />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
