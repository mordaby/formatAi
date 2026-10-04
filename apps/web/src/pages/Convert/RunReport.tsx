// What a finished run reports (SPEC 16.1 screen 6): the numbers (rows in and out, filtered, duplicates, and what the user decided in
// the review), the flags, and the first rows of the file. Shared by the Convert screen's result and the Result screen's "Try it on
// another file", which run different rules the same way. Nothing here leaves the browser.
import type { Flag, OutCell, OutputSheet } from '@formatai/engine';
import type { LearnResult, PayloadCell, Rules } from '@formatai/shared';
import { Cell } from '../../components/Cell';
import { SheetDirection } from '../../components/SheetDirection';
import { webConfig } from '../../config';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Icon } from '../../ui';
import { formatPreview } from '../Result/formatPreview';
import { columnLabel, flaggedRowCount } from './logic';
import type { Finished } from './useConvertFlow';

export interface RunReportProps {
  /** The rules the run used: flags are named from them. */
  rules: LearnResult | Rules;
  finished: Finished;
}

export function RunReport({ rules, finished }: RunReportProps) {
  const { t, lang } = useI18n();
  const nf = new Intl.NumberFormat(lang);
  const { summary, flags } = finished;

  // The numbers that are always shown, then only the ones that happened.
  const stats: { key: MessageKey; n: number; always?: boolean; id: string }[] = [
    { id: 'rowsIn', key: 'conv.sum.rowsIn', n: summary.rowsIn, always: true },
    { id: 'rowsOut', key: 'conv.sum.rowsOut', n: summary.rowsOut, always: true },
    { id: 'filtered', key: 'conv.sum.filtered', n: summary.rowsFiltered },
    { id: 'duplicates', key: 'conv.sum.duplicates', n: summary.duplicatesRemoved.length },
    { id: 'duplicatesFlagged', key: 'conv.sum.duplicatesFlagged', n: summary.duplicatesFlagged },
    { id: 'blocked', key: 'conv.sum.blocked', n: summary.blockedRows.length },
    { id: 'skipped', key: 'conv.sum.skipped', n: summary.skippedByUser?.length ?? 0 },
    { id: 'edited', key: 'conv.sum.edited', n: summary.editedByUser?.length ?? 0 },
    { id: 'accepted', key: 'conv.sum.accepted', n: summary.acceptedByUser?.length ?? 0 },
    { id: 'flagged', key: 'conv.sum.flagged', n: flaggedRowCount(flags) },
  ];
  const shownFlags = flags.slice(0, webConfig.convertFlagRows);

  return (
    <>
      <dl className="stats" data-testid="run-summary">
        {stats
          .filter((s) => s.always || s.n > 0)
          .map((s) => (
            <div className="stat" key={s.id} data-stat={s.id}>
              <dt>{t(s.key)}</dt>
              <dd className="tabular">{nf.format(s.n)}</dd>
            </div>
          ))}
      </dl>

      {(summary.blockedInWindows ?? 0) > 0 && (
        // Across-row results (totals, running balances, ranks) were calculated over the rows a check later left out: counts only.
        <p className="muted" data-testid="blocked-in-windows">
          {t(summary.blockedInWindows === 1 ? 'conv.sum.blockedInWindows.one' : 'conv.sum.blockedInWindows.other', { n: nf.format(summary.blockedInWindows ?? 0) })}
        </p>
      )}

      <section className="flags" aria-label={t('conv.done.flags.title')} data-testid="run-flags">
        <h3 className="flags__title">{t('conv.done.flags.title')}</h3>
        {flags.length === 0 ? <p className="flags__none">{t('conv.done.flags.none')}</p> : null}
        {shownFlags.length > 0 ? (
          <ul className="flags__list">
            {shownFlags.map((f, i) => (
              <FlagItem key={`${f.rowNumber}|${f.column}|${f.rule}|${i}`} flag={f} rules={rules} />
            ))}
          </ul>
        ) : null}
        {flags.length > shownFlags.length ? <p className="muted">{t('conv.done.flags.more', { shown: nf.format(shownFlags.length), n: nf.format(flags.length) })}</p> : null}
      </section>

      <OutputPreview sheet={finished.preview} total={finished.totalRows} />
    </>
  );
}

function FlagItem({ flag, rules }: { flag: Flag; rules: LearnResult | Rules }) {
  const { t, code } = useI18n();
  return (
    <li className="flag" data-decision={flag.accepted ? 'accepted' : undefined}>
      <Icon name="alert" size={16} className="flag__icon" />
      <div className="flag__body">
        <p className="flag__where tabular">
          {t('conv.review.row', { row: flag.rowNumber })} · <bdi className="sentence__name">{columnLabel(rules, flag.column)}</bdi>
          {flag.value !== null && flag.value !== '' ? (
            <>
              {' · '}
              <Cell value={String(flag.value)} />
            </>
          ) : null}
        </p>
        <p>{code({ kind: 'flag', code: flag.messageKey, ...(flag.params ? { params: flag.params } : {}) })}</p>
        {flag.accepted ? (
          <p>
            <Badge tone="verified">{t('conv.done.flags.accepted')}</Badge>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** What a written cell shows: a date by its own text, a number by the column's format, text as it is. */
function cellText(cell: OutCell, format: string | undefined, language: 'he' | 'en'): string {
  if (cell.text !== undefined) return cell.text;
  if (cell.v === null || cell.v === '') return '';
  if (cell.isDate === true) return String(cell.v);
  return formatPreview(cell.z ?? format, cell.v as PayloadCell, language);
}

/** The first rows of the file just made, in the sheet's own direction (SPEC 16.2). */
function OutputPreview({ sheet, total }: { sheet: OutputSheet; total: number }) {
  const { t, lang } = useI18n();
  const nf = new Intl.NumberFormat(lang);
  const rows = sheet.rows;
  if (rows.length === 0) return null;
  return (
    <section className="preview" aria-label={t('conv.done.preview.title')} data-testid="run-preview">
      <h3 className="preview__title">{t('conv.done.preview.title')}</h3>
      <SheetDirection direction={sheet.direction} className="pv__scroll">
        <table className="pv">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={row.kind === 'data' ? 'pv__row' : 'pv__row pv__row--meta'} data-kind={row.kind}>
                {row.cells.map((cell, c) => {
                  const text = cellText(cell, sheet.columns[c]?.format, sheet.language);
                  const cls = ['pv__cell', typeof cell.v === 'number' ? 'pv__num' : '', cell.flagged ? 'pv__flag' : ''].filter(Boolean).join(' ');
                  return row.kind === 'header' ? (
                    <th key={c} scope="col" className={cell.flagged ? 'pv__flag' : undefined}>
                      <Cell value={text} />
                    </th>
                  ) : (
                    <td key={c} className={cls} data-flag={cell.flagged ? 'true' : undefined}>
                      <Cell value={text} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </SheetDirection>
      {total > rows.length ? <p className="muted">{t('conv.done.preview.more', { shown: nf.format(rows.length), total: nf.format(total) })}</p> : null}
    </section>
  );
}
