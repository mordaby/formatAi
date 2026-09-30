// The result of a file that fed several formats (SPEC 5 C, 8.15): one line per format (rows in and out, flagged rows, an
// individual download), the formats that could not be made and why, and "Download all (zip)" - a folder per format plus a small
// summary sheet. Exactly one result is not shown here: that is `RunDone`, as before. Nothing here leaves the browser.
import { Link } from 'react-router-dom';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, InlineMessage, Spinner } from '../../ui';
import { columnLabel, flaggedRowCount, isolate } from './logic';
import { failureText, type FailedFormat, type RunResult } from './useConvertFlow';

const FLAGS_LISTED = 20;

export interface RunResultsProps {
  sourceName: string;
  results: readonly RunResult[];
  failed: readonly FailedFormat[];
  aliasNotSaved: boolean;
  packing: boolean;
  packError: boolean;
  onDownloadOne(conversionId: string): void;
  onDownloadAll(): void;
  onAnother(): void;
}

export function RunResults({ sourceName, results, failed, aliasNotSaved, packing, packError, onDownloadOne, onDownloadAll, onAnother }: RunResultsProps) {
  const i18n = useI18n();
  const { t, code, lang } = i18n;
  const nf = new Intl.NumberFormat(lang);

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

      {failed.length > 0 ? (
        <section className="bgroup" aria-label={t('conv.results.failed.title')} data-testid="result-failed">
          <h3 className="bgroup__title">{t('conv.results.failed.title')}</h3>
          <ul className="bfiles">
            {failed.map((x) => (
              <li className="bfile" key={x.conversionId} data-status="noMatch">
                <div className="bfile__main">
                  <p className="bfile__name">
                    <Cell value={x.formatName} empty="—" />
                  </p>
                  <p className="muted bfile__reason">{failureText(i18n, x.failure)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="conv__foot">
        <Link to="/formats">{t('conv.done.formats')}</Link>
      </p>
    </section>
  );
}
