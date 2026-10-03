// The result of a file that fed several formats (SPEC 5 C, 8.15): one line per format (rows in and out, flagged rows, an
// individual download), the formats that need attention (SPEC 21 v12: why, and "Open in editor" / "Run anyway"), the ones that could
// not be made and why, and "Download all (zip)" - a folder per format plus a small summary sheet. Exactly one result and nothing else
// is not shown here: that is `RunDone`, as before. Nothing here leaves the browser.
import { Link } from 'react-router-dom';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, InlineMessage, Spinner } from '../../ui';
import { runAnywayLabel } from './attention';
import { columnLabel, flaggedRowCount, isolate } from './logic';
import { AttentionList, AttentionRow } from './NeedsAttention';
import { NewColumns } from './NewColumns';
import { failureText, type FailedFormat, type NewColumnsNotice, type RunResult } from './useConvertFlow';

const FLAGS_LISTED = 20;

export interface RunResultsProps {
  sourceName: string;
  results: readonly RunResult[];
  failed: readonly FailedFormat[];
  aliasNotSaved: boolean;
  /** "New column in this file" (SPEC 8.15), when there is one to mention. */
  notice: NewColumnsNotice | null;
  packing: boolean;
  packError: boolean;
  onDownloadOne(conversionId: string): void;
  onDownloadAll(): void;
  onAnother(): void;
  /** A format that needs attention: its editor (the page holds the file for the trip), or making it now anyway. */
  onEdit(format: { conversionId: string; formatId: string }): void;
  onRunAnyway(conversionId: string): void;
  onDismissNotice(): void;
}

export function RunResults({ sourceName, results, failed, aliasNotSaved, notice, packing, packError, onDownloadOne, onDownloadAll, onAnother, onEdit, onRunAnyway, onDismissNotice }: RunResultsProps) {
  const i18n = useI18n();
  const { t, code, lang } = i18n;
  const nf = new Intl.NumberFormat(lang);
  // Formats not made because this file needs the user's decision first are listed apart from the ones that failed.
  const needAttention = failed.flatMap((x) => (x.failure.kind === 'attention' ? [{ ...x, failure: x.failure }] : []));
  const couldNot = failed.filter((x) => x.failure.kind !== 'attention');

  return (
    <section className="conv__step" aria-labelledby="conv-results-title" data-testid="run-results">
      <header className="conv__head">
        <h2 id="conv-results-title">{t(results.length === 0 ? 'conv.results.title.none' : results.length === 1 ? 'conv.results.title.one' : 'conv.results.title.other', { n: nf.format(results.length) })}</h2>
        <p className="muted">{t('conv.results.source', { source: isolate(sourceName) })}</p>
      </header>

      <div className="conv__actions">
        {results.length > 0 ? (
          <Button variant="primary" icon="file" onClick={onDownloadAll} disabled={packing}>
            {t('conv.results.downloadAll')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onAnother}>
          {t('conv.done.another')}
        </Button>
      </div>
      {packing ? (
        <p className="muted conv__wait" role="status">
          <Spinner size={16} /> {t('batch.packing')}
        </p>
      ) : null}
      {packError ? <InlineMessage tone="error">{t('batch.packError')}</InlineMessage> : null}
      {aliasNotSaved ? <p className="muted">{t('conv.map.aliasNotSaved')}</p> : null}

      {results.length > 0 ? (
        <>
          <p className="muted">{t('conv.results.note')}</p>
          <ul className="bfiles" data-testid="result-list">
            {results.map((r) => {
              const { summary, flags } = r.finished;
              const flagRows = flaggedRowCount(flags);
              return (
                <li className="bfile" key={r.target.conversionId} data-status={flagRows > 0 ? 'convertedFlags' : 'converted'} data-testid="result-format">
                  <div className="bfile__main">
                    <p className="bfile__name">
                      <Cell value={r.target.formatName} />
                    </p>
                    <p className="muted bfile__meta tabular">
                      {t('batch.rows', { rowsIn: nf.format(summary.rowsIn), rowsOut: nf.format(summary.rowsOut) })}
                      {flagRows > 0 ? ` · ${t(flagRows === 1 ? 'batch.flagsCount.one' : 'batch.flagsCount.other', { n: nf.format(flagRows) })}` : ''}
                    </p>
                    <p className="muted conv__name">
                      <Cell value={r.finished.fileName} />
                    </p>
                    {flags.length > 0 ? (
                      <details className="bfile__flags">
                        <summary>{t(flagRows === 1 ? 'batch.flagsCount.one' : 'batch.flagsCount.other', { n: nf.format(flagRows) })}</summary>
                        <ul>
                          {flags.slice(0, FLAGS_LISTED).map((f, k) => (
                            <li key={`${f.rowNumber}|${f.column}|${k}`} className="tabular">
                              {t('conv.review.row', { row: f.rowNumber })} · <bdi>{columnLabel(r.target.rules, f.column)}</bdi> · {code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <Button variant="secondary" size="sm" icon="file" aria-label={t('conv.results.downloadOne', { format: isolate(r.target.formatName) })} onClick={() => onDownloadOne(r.target.conversionId)}>
                    {t('conv.results.download')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {needAttention.length > 0 ? (
        <AttentionList>
          {needAttention.map((x) => {
            const label = runAnywayLabel(i18n, x.failure.attention);
            return (
              <AttentionRow key={x.conversionId} formatName={x.formatName} attention={x.failure.attention}>
                {x.failure.skipped ? (
                  <span className="muted">{t('conv.attention.skipped')}</span>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => onEdit(x)}>
                      {t('conv.attention.edit')}
                    </Button>
                    {label ? (
                      <Button variant="secondary" size="sm" onClick={() => onRunAnyway(x.conversionId)}>
                        {label}
                      </Button>
                    ) : null}
                  </>
                )}
              </AttentionRow>
            );
          })}
        </AttentionList>
      ) : null}

      {couldNot.length > 0 ? (
        <section className="bgroup" aria-label={t('conv.results.failed.title')} data-testid="result-failed">
          <h3 className="bgroup__title">{t('conv.results.failed.title')}</h3>
          <ul className="bfiles">
            {couldNot.map((x) => (
              <li className="bfile" key={x.conversionId} data-status="noMatch">
                <div className="bfile__main">
                  <p className="bfile__name">
                    <Cell value={x.formatName} empty="—" />
                  </p>
                  <p className="muted bfile__reason">{failureText(i18n, x.failure, x.formatName)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notice ? <NewColumns notice={notice} onDismiss={onDismissNotice} onAdd={onEdit} /> : null}

      <p className="conv__foot">
        <Link to="/formats">{t('conv.done.formats')}</Link>
      </p>
    </section>
  );
}
