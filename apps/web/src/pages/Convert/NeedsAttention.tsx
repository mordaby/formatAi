// The formats that "need attention" (SPEC 8.15, 21 v11 items 4-7): a column a format uses is not in this file, or most of its values are not like
// before. A list with one row per format - why, in plain words, and what the user can do about it (the actions are the caller's: before
// a run it is "Open in editor", "Skip this time" and "Run anyway", after one only the first and last). Nothing is changed for them.
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { attentionLines } from './attention';
import type { Attention } from './logic';

export function AttentionList({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="bgroup" aria-label={t('conv.attention.section')} data-testid="needs-attention">
      <h3 className="bgroup__title">{t('conv.attention.section')}</h3>
      <ul className="bfiles">{children}</ul>
    </section>
  );
}

export interface AttentionRowProps {
  formatName: string;
  attention: Attention;
  /** The actions, or what the user already chose. */
  children?: ReactNode;
}

export function AttentionRow({ formatName, attention, children }: AttentionRowProps) {
  const i18n = useI18n();
  const lines = attentionLines(i18n, formatName, attention);
  return (
    <li className="bfile" data-status="needsAttention" data-testid="attention-format">
      <div className="bfile__main">
        {lines.map((line, i) => (
          <p key={i} className={i === 0 ? 'bfile__name' : 'muted bfile__reason'} data-testid="attention-text">
            {line}
          </p>
        ))}
      </div>
      {children ? <div className="bfile__actions">{children}</div> : null}
    </li>
  );
}
