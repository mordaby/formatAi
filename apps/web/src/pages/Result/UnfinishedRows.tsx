// When the AI step could not finish (SPEC 8.11 "Rows the rules don't reproduce", 21 v12 item 12; docs/proposals/learning-loop.md 3.5, 7.3): the
// learning loop stopped without every row matching - no progress, a cap, nothing more to send - or the answer was kept with differences. The
// best answer is on screen and these rows still come out different, so they are shown, grouped per column: "3 rows don't follow the rule we found
// for Priority: rows 38, 89, 132", with the real values of the first few (the values are read from the checked example, on this computer;
// nothing is sent) and, per column, the two ways forward: Fix the rule (the editor opens on that column) or Leave it empty for now (the column
// becomes "needs your input", today's best-we-can-do path). The preview below highlights the same rows.
// DECISION (owner, open question 3 of the proposal): there is NO "keep these rows as they are" here - bringing rows edited by hand back as
// exceptions waits for the owner's answer.
import { useMemo } from 'react';
import { Cell } from '../../components/Cell';
import type { EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, Icon } from '../../ui';
import type { LiveCheckResult } from '../../worker/editorApi';
import { formatPreview } from './formatPreview';
import { columnMismatches } from './helpers';
import { FixRuleButton } from './MismatchNotice';
import { Marked } from './Named';

/** How many of a column's rows show their values (the first ones; the preview below has the rest). */
const ROWS_WITH_VALUES = 3;

export interface UnfinishedRowsProps {
  rules: EditableRules;
  /** The live check of the rules on the example (real values: they are shown here and never sent). */
  live: LiveCheckResult | null;
  /** "Fix the rule": opens the editor on that column. */
  onFix(header: string): void;
  /** "Leave it empty for now": the column becomes "needs your input". */
  onLeave(index: number, header: string): void;
}

export function UnfinishedRows({ rules, live, onFix, onLeave }: UnfinishedRowsProps) {
  const { t, lang } = useI18n();
  const language = rules.output.language;
  const groups = useMemo(() => columnMismatches(live, rules).filter((m) => rules.output.columns[m.index]?.from !== null), [live, rules]);
  if (!live || groups.length === 0) return null;
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
  const show = (index: number, v: unknown): string => {
    if (v === null || v === undefined || v === '') return t('unfinished.empty');
    return formatPreview(rules.output.columns[index]?.format, v as never, language);
  };

  return (
    <section className="deep unfinished" data-tone="warn" aria-labelledby="unfinished-title" data-testid="unfinished-rows">
      <h2 className="deep__title" id="unfinished-title">
        {t('unfinished.title')}
      </h2>
      <p className="deep__note">{t('unfinished.lead')}</p>
      <div className="unfinished__groups">
        {groups.map((m) => {
          const rest = m.count - m.rows.length;
          const list = m.rows.join(', ');
          const rows = live.mismatches.filter((x) => (x.columnIndex === m.index || (x.columnIndex < 0 && x.column === m.header)) && m.rows.includes(x.exampleRow));
          return (
            <div key={m.index} className="unfinished__group" data-column={m.header} data-testid="unfinished-group">
              <p>
                <Icon name="alert" size={16} />{' '}
                <Marked
                  id={m.count === 1 ? 'unfinished.group.one' : 'unfinished.group.other'}
                  nodes={{
                    column: <bdi className="sentence__name">{m.header}</bdi>,
                    n: number(m.count),
                    list: rest > 0 ? <Marked id="unfinished.more" nodes={{ list, n: number(rest) }} /> : list,
                  }}
                />
              </p>
              <ul className="unfinished__rows">
                {rows.slice(0, ROWS_WITH_VALUES).map((x) => (
                  <li key={x.exampleRow} data-row={x.exampleRow}>
                    <Marked
                      id="unfinished.row"
                      nodes={{
                        row: <span className="tabular">{x.exampleRow}</span>,
                        expected: <Cell value={show(m.index, x.expected)} />,
                        actual: <Cell value={show(m.index, x.actual)} />,
                      }}
                    />
                  </li>
                ))}
              </ul>
              <div className="unfinished__actions">
                <FixRuleButton header={m.header} variant="secondary" onFix={() => onFix(m.header)} />
                <Button variant="secondary" size="sm" aria-label={t('unfinished.leave.label', { column: m.header })} onClick={() => onLeave(m.index, m.header)}>
                  {t('unfinished.leave')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

