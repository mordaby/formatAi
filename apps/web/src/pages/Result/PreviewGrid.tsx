// The preview grid (SPEC 8.11 "Live check", 16.1 screen 4): the converted example in the SHEET's direction, mismatching rows
// first with the differing cells in amber, what doesn't match said per column above the table (with "Fix the rule"), flagged
// cells, and the free tier's 20 rows.
//
// A column with NO RULE yet (nothing fills it, or the AI step has not worked it out) shows EMPTY cells and "No rule yet" in its header: the
// example's values would look like the rule's output. They can be shown on request (a toggle), each one labelled "Your example: ...".
import type { Flag } from '@formatai/engine';
import type { PayloadCell } from '@formatai/shared';
import { Fragment, useMemo, useState, type ReactElement } from 'react';
import { Cell } from '../../components/Cell';
import { SheetDirection } from '../../components/SheetDirection';
import type { EditableRules } from '../../editor';
import { useI18n, type Direction } from '../../i18n';
import { Button, Icon, Spinner } from '../../ui';
import type { LiveCheckResult, PreviewRow } from '../../worker/editorApi';
import { formatPreview } from './formatPreview';
import { columnMismatches, columnsWithoutRule } from './helpers';
import { FixRuleButton, MismatchMessage } from './MismatchNotice';

export interface PreviewGridProps {
  live: LiveCheckResult | null | undefined;
  rules: EditableRules;
  /** Flags from running the rules on the example input (SPEC 8.9): flagged cells show amber with the message. */
  flags: readonly Flag[];
  /** Rows shown on screen; `null` = as many as the check returned. */
  limit: number | null;
  /** The UI's direction (notes and buttons follow it; the cells follow the sheet). */
  uiDir: Direction;
  /** "Fix the rule": opens the editor of this output column. */
  onFixRule(header: string): void;
  onSignIn(): void;
}

/** Which output column a flag is about: the column that reads its id, else the one with that header. */
export function flagColumn(rules: EditableRules, flag: Flag): number {
  const byFrom = rules.output.columns.findIndex((c) => c.from === flag.column);
  return byFrom >= 0 ? byFrom : rules.output.columns.findIndex((c) => c.header === flag.column);
}

export function PreviewGrid({ live, rules, flags, limit, uiDir, onFixRule, onSignIn }: PreviewGridProps) {
  const { t, code, lang } = useI18n();
  const direction = rules.output.direction;
  const language = rules.output.language;

  // Whether the cells of columns with no rule show what the example has there (as a labelled target, never as the rule's output).
  const [showTarget, setShowTarget] = useState(false);
  const withoutRule = useMemo(() => columnsWithoutRule(rules), [rules]);

  const flagsByCell = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const f of flags) {
      const c = flagColumn(rules, f);
      if (c < 0) continue;
      const key = `${f.rowNumber}:${c}`;
      const text = code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) });
      map.set(key, [...(map.get(key) ?? []), text]);
    }
    return map;
  }, [flags, rules, code]);

  if (!live) {
    return (
      <section className="preview" aria-label={t('preview.title')}>
        <h2 className="preview__title">{t('preview.title')}</h2>
        <p className="muted preview__wait">
          <Spinner size={16} /> {t('check.checking')}
        </p>
      </section>
    );
  }

  // A column the rules don't have at all (the example has more columns than the rules) has no rule either.
  const columns = live.perColumn.map((c, i) => ({ ...c, i, noRule: rules.output.columns[i] === undefined || withoutRule.has(rules.output.columns[i]!.header) })).filter((c) => c.inExample);
  const anyNoRule = columns.some((c) => c.noRule);
  const rows = limit === null ? live.preview : live.preview.slice(0, limit);
  const totalRows = live.total;
  const hiddenColumns = live.perColumn.some((c) => !c.inExample);
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
  const differing = rows.filter((r) => !r.ok).length;
  const issues = columnMismatches(live, rules);

  const show = (v: PayloadCell | undefined, index: number): string => formatPreview(rules.output.columns[index]?.format, v, language);
  const isNumber = (v: PayloadCell | undefined): boolean => typeof v === 'number';

  const cellsOf = (row: PreviewRow, values: readonly PayloadCell[], kind: 'example' | 'rule' | 'plain'): ReactElement[] =>
    columns.map(({ i, noRule }) => {
      const v = values[i];
      if (noRule && kind !== 'example') {
        // No rule: nothing is converted here. The example's value is only ever shown as a labelled target, and only when asked for.
        const target = row.expected[i];
        const label = showTarget && target !== null && target !== undefined && target !== '' ? show(target, i) : '';
        return (
          <td key={i} className="pv__cell pv__cell--norule" data-no-rule="true">
            {label !== '' && (
              <span className="pv__target" data-testid="preview-target">
                <span className="pv__target-label">{t('preview.targetLabel')}</span> <Cell value={label} />
              </span>
            )}
          </td>
        );
      }
      const diff = !row.ok && row.badColumns.includes(i);
      const flagText = row.inputRow !== undefined ? flagsByCell.get(`${row.inputRow}:${i}`) : undefined;
      const cls = ['pv__cell', isNumber(v) ? 'pv__num' : '', diff ? `pv__diff pv__diff--${kind}` : '', flagText ? 'pv__flag' : ''].filter(Boolean).join(' ');
      return (
        <td key={i} className={cls} title={flagText?.join(' ')} data-flag={flagText ? 'true' : undefined}>
          <Cell value={show(v, i)} />
          {flagText && kind !== 'example' && <span className="visually-hidden"> ({flagText.join(' ')})</span>}
        </td>
      );
    });

  return (
    <section className="preview" aria-label={t('preview.title')} data-testid="preview">
      <header className="preview__head">
        <h2 className="preview__title">{t('preview.title')}</h2>
        <p className="muted">{differing > 0 ? t('preview.differFirst') : t('preview.allMatch')}</p>
      </header>

      {issues.length > 0 && (
        <ul className="pv__issues" data-testid="column-issues">
          {issues.map((m) => (
            <li key={m.index} data-column={m.header} data-failing={m.failing || undefined}>
              <Icon name="alert" size={16} />
              <span>
                <MismatchMessage mismatch={m} named />
              </span>
              <FixRuleButton header={m.header} onFix={() => onFixRule(m.header)} />
            </li>
          ))}
        </ul>
      )}

      {anyNoRule && (
        <p className="pv__target-toggle">
          <Button variant="link" aria-pressed={showTarget} onClick={() => setShowTarget((on) => !on)}>
            {t(showTarget ? 'preview.hideTarget' : 'preview.showTarget')}
          </Button>
        </p>
      )}

      <SheetDirection direction={direction} className="pv__scroll">
        <table className="pv" data-testid="preview-table" aria-label={t('preview.title')}>
          <thead>
            <tr>
              <th scope="col" className="pv__n">
                <span className="visually-hidden">{t('preview.row')}</span>
                <span aria-hidden="true">#</span>
              </th>
              {columns.map((c) => (
                <th key={c.i} scope="col" data-no-rule={c.noRule ? 'true' : undefined}>
                  <Cell value={c.header} />
                  {c.noRule && (
                    <span className="pv__norule" data-testid="no-rule-marker">
                      {t('preview.noRule')}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.ok ? (
                <tr key={row.exampleRow} className="pv__row" data-row={row.exampleRow}>
                  <th scope="row" className="pv__n tabular">
                    {row.exampleRow}
                  </th>
                  {cellsOf(row, row.actual, 'plain')}
                </tr>
              ) : (
                <Fragment key={row.exampleRow}>
                  <tr className="pv__note" data-row={row.exampleRow} data-mismatch="true">
                    <td colSpan={columns.length + 1}>
                      <div className="pv__notebar" dir={uiDir}>
                        <span className="tabular">
                          {t('preview.rowDiffers', { row: row.exampleRow })}{' '}
                          {row.badColumns.map((c, k) => (
                            <Fragment key={c}>
                              {k > 0 ? ', ' : ''}
                              <bdi className="sentence__name">{live.perColumn[c]?.header ?? ''}</bdi>
                            </Fragment>
                          ))}
                        </span>
                      </div>
                    </td>
                  </tr>
                  <tr className="pv__row pv__row--example">
                    <th scope="row" className="pv__n pv__label">
                      {t('preview.yourExample')}
                    </th>
                    {cellsOf(row, row.expected, 'example')}
                  </tr>
                  <tr className="pv__row pv__row--rule">
                    <th scope="row" className="pv__n pv__label">
                      {t('preview.thisRule')}
                    </th>
                    {cellsOf(row, row.actual, 'rule')}
                  </tr>
                </Fragment>
              ),
            )}
          </tbody>
        </table>
      </SheetDirection>

      {rows.length === 0 && <p className="muted">{t('preview.empty')}</p>}
      {hiddenColumns && <p className="muted">{t('preview.newColumns')}</p>}

      {limit !== null && totalRows > rows.length ? (
        <p className="preview__more">
          <Button variant="link" onClick={onSignIn}>
            {t('preview.signIn', { n: number(totalRows) })}
          </Button>
        </p>
      ) : totalRows > rows.length ? (
        <p className="muted">{t('preview.showingFirst', { shown: number(rows.length), n: number(totalRows) })}</p>
      ) : null}
    </section>
  );
}
