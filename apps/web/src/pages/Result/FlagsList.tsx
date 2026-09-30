// The flagged rows from a run of the rules on the example input (SPEC 8.9, 16.1 screen 4): each flag says what is wrong in
// plain words, and a mechanical suggestion (padding, a swapped day and month) can be accepted or rejected.
import type { Flag, RunSummary } from '@formatai/engine';
import { useState } from 'react';
import { Cell } from '../../components/Cell';
import type { EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, Icon } from '../../ui';
import { flagColumn } from './PreviewGrid';

type Decision = 'accepted' | 'rejected';

export interface FlagsListProps {
  flags: readonly Flag[];
  summary: RunSummary | undefined;
  rules: EditableRules;
  /** Flags shown on screen (the free tier's 20); `null` = all. */
  limit: number | null;
  onSignIn(): void;
}

export function FlagsList({ flags, summary, rules, limit, onSignIn }: FlagsListProps) {
  const { t, code, lang } = useI18n();
  // Decisions are kept by the flag's own row, column and rule, so a re-run of the same rules keeps them.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
  const keyOf = (f: Flag): string => `${f.rowNumber}|${f.column}|${f.rule}`;

  if (!summary && flags.length === 0) return null;
  const shown = limit === null ? flags : flags.slice(0, limit);

  return (
    <section className="flags" aria-label={t('flags.title')} data-testid="flags">
      <h2 className="flags__title">{flags.length > 0 ? t('flags.titleCount', { n: number(flags.length) }) : t('flags.title')}</h2>
      {summary && (
        <p className="muted tabular" data-testid="run-summary">
          {t('flags.summary', { rowsIn: number(summary.rowsIn), rowsOut: number(summary.rowsOut) })}
          {summary.rowsFiltered > 0 ? ` ${t('flags.filtered', { n: number(summary.rowsFiltered) })}` : ''}
          {summary.duplicatesRemoved.length > 0 ? ` ${t('flags.removedDuplicates', { n: number(summary.duplicatesRemoved.length) })}` : ''}
        </p>
      )}
      {flags.length === 0 && <p className="flags__none">{t('flags.none')}</p>}
      {shown.length > 0 && (
        <ul className="flags__list">
          {shown.map((f) => {
            const c = flagColumn(rules, f);
            const header = c >= 0 ? rules.output.columns[c]!.header : f.column;
            const decision = decisions[keyOf(f)];
            return (
              <li key={keyOf(f)} className="flag" data-decision={decision}>
                <Icon name="alert" size={16} className="flag__icon" />
                <div className="flag__body">
                  <p className="flag__where tabular">
                    {t('preview.rowN', { row: f.rowNumber })} · <bdi className="sentence__name">{header}</bdi>
                    {f.value !== null && f.value !== '' ? (
                      <>
                        {' · '}
                        <Cell value={String(f.value)} />
                      </>
                    ) : null}
                  </p>
                  <p>{code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })}</p>
                  {f.suggestion !== undefined && (
                    <div className="flag__suggestion">
                      <span>
                        {t('flags.suggestion')} <bdi className="tabular">{String(f.suggestion)}</bdi>
                      </span>
                      {decision ? (
                        <>
                          <span className="flag__decided">{t(decision === 'accepted' ? 'flags.accepted' : 'flags.rejected')}</span>
                          <Button variant="link" onClick={() => setDecisions(({ [keyOf(f)]: _drop, ...rest }) => (void _drop, rest))}>
                            {t('flags.undo')}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => setDecisions((d) => ({ ...d, [keyOf(f)]: 'accepted' }))}>
                            {t('flags.accept')}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setDecisions((d) => ({ ...d, [keyOf(f)]: 'rejected' }))}>
                            {t('flags.reject')}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {limit !== null && flags.length > shown.length && (
        <p className="preview__more">
          <Button variant="link" onClick={onSignIn}>
            {t('flags.signIn', { n: number(flags.length) })}
          </Button>
        </p>
      )}
    </section>
  );
}
