// The live check strip (SPEC 8.11 "Live check"): "Matches X of Y rows in your example", updated about 150 ms after every
// change, with what differs in the layout and the problems the static checks found, in plain words.
import type { LayoutProblemCode } from '@formatai/engine';
import type { UseLiveCheck } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, Icon, Spinner } from '../../ui';

const LAYOUT_TEXT: Record<LayoutProblemCode, MessageKey> = {
  runFailed: 'check.layout.runFailed',
  unalignedRows: 'check.layout.unalignedRows',
  rowCount: 'check.layout.rowCount',
  fileSettings: 'check.layout.fileSettings',
  titleRow: 'check.layout.titleRow',
  headerRow: 'check.layout.headerRow',
  blankRow: 'check.layout.blankRow',
  summaryRow: 'check.layout.summaryRow',
};

export function LiveCheckStrip({ check }: { check: UseLiveCheck }) {
  const { t, lang } = useI18n();
  const s = check.state;
  const live = s.live;
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');

  let tone: 'ok' | 'diff' | 'busy' | 'quiet' = 'busy';
  let text: string;
  let action = false;
  if (s.status === 'noExample') {
    tone = 'quiet';
    text = t('check.noExample');
  } else if (!live && s.status === 'error') {
    tone = 'diff';
    text = t('check.failed');
    action = true;
  } else if (!live) {
    text = t('check.checking');
  } else if (live.partial) {
    tone = 'quiet';
    text = t('check.partial', { n: number(live.checkedInputRows) });
    action = true;
  } else {
    tone = live.verified ? 'ok' : 'diff';
    text = t('check.matches', { matched: number(live.matched), total: number(live.total) });
  }
  if (live && !live.partial && s.status === 'error') action = true;

  const codes = live ? [...new Set(live.layoutIssues.map((i) => i.code))].slice(0, 4) : [];
  const more = live ? new Set(live.layoutIssues.map((i) => i.code)).size - codes.length : 0;

  return (
    <section className="strip" aria-label={t('check.label')} data-tone={tone}>
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
            {t('check.apply')}
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
