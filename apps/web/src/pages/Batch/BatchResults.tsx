// The batch result (SPEC 5 D, 8.15, 16.1 screen 6): grouped by format, a status for every file (converted, converted with flags,
// needs attention, didn't match, with the reason) - a file whose source feeds several formats appears under each of them - and the two
// downloads: the zip of every converted file and the summary sheet of flags. A format that needs attention (SPEC 21 v12) is listed apart,
// with why, while the file's other formats are converted.
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Badge, Button, InlineMessage, Spinner } from '../../ui';
import { isolate } from '../Convert/logic';
import { reasonText, type BatchItem, type BatchStatus, type UseBatchFlow } from './useBatchFlow';

const FLAGS_LISTED = 20;

export function statusBadgeTone(status: BatchStatus): 'verified' | 'check' | 'neutral' {
  return status === 'converted' ? 'verified' : status === 'queued' || status === 'running' ? 'neutral' : 'check';
}

export function StatusBadge({ status }: { status: BatchStatus }) {
  const { t } = useI18n();
  const key = `batch.status.${status}` as const;
  return (
    <Badge tone={statusBadgeTone(status)}>
      {status === 'running' ? <Spinner size={12} /> : null}
      {t(key)}
    </Badge>
  );
}

export interface BatchGroup {
  /** The format's name; `null` for the files that need attention or didn't match. */
  format: string | null;
  /** The group of formats that need attention (SPEC 21 v12), as opposed to the files that didn't match. */
  attention?: true;
  items: BatchItem[];
}

/** Converted files by format (in the order formats first appear), then the formats that need attention, then the files that didn't match. */
export function groupByFormat(items: readonly BatchItem[]): BatchGroup[] {
  const byFormat = new Map<string, BatchItem[]>();
  const attention: BatchItem[] = [];
  const unmatched: BatchItem[] = [];
  for (const i of items) {
    if (i.status === 'converted' || i.status === 'convertedFlags') {
      const key = i.formatName ?? '';
      byFormat.set(key, [...(byFormat.get(key) ?? []), i]);
    } else if (i.status === 'needsAttention') attention.push(i);
    else if (i.status === 'noMatch') unmatched.push(i);
  }
  const groups: BatchGroup[] = [...byFormat.entries()].map(([format, list]) => ({ format, items: list }));
  if (attention.length > 0) groups.push({ format: null, attention: true, items: attention });
  if (unmatched.length > 0) groups.push({ format: null, items: unmatched });
  return groups;
}

export function BatchResults({ flow }: { flow: UseBatchFlow }) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const nf = new Intl.NumberFormat(lang);
  const groups = groupByFormat(flow.items);
  const converted = flow.items.filter((i) => i.status === 'converted').length;
  const withFlags = flow.items.filter((i) => i.status === 'convertedFlags').length;
  const noMatch = flow.items.filter((i) => i.status === 'noMatch').length;
  const attention = flow.items.filter((i) => i.status === 'needsAttention').length;

  return (
    <section className="conv__step" aria-labelledby="batch-done-title" data-testid="batch-results">
      <header className="conv__head">
        <h2 id="batch-done-title">{t('batch.done.title')}</h2>
        <p className="lead tabular" data-testid="batch-counts">
          {t('batch.done.counts', { converted: nf.format(converted), flags: nf.format(withFlags), noMatch: nf.format(noMatch) })}
          {attention > 0 ? ` · ${t('batch.done.attention', { n: nf.format(attention) })}` : ''}
        </p>
        {flow.stopped ? <p className="muted">{t('batch.stopped')}</p> : null}
      </header>

      {flow.phase === 'packing' ? (
        <p className="muted conv__wait" role="status">
          <Spinner size={16} /> {t('batch.packing')}
        </p>
      ) : flow.downloads ? (
        <>
          <div className="conv__actions">
            <Button variant="primary" icon="file" onClick={flow.downloadZip}>
              {t('batch.done.download')}
            </Button>
            <Button variant="secondary" onClick={flow.downloadSummary}>
              {t('batch.done.summary')}
            </Button>
            <Button variant="ghost" onClick={flow.reset}>
              {t('batch.done.another')}
            </Button>
          </div>
          <p className="muted">{t('batch.done.note')}</p>
        </>
      ) : (
        <>
          {flow.packError ? <InlineMessage tone="error">{t('batch.packError')}</InlineMessage> : <p className="muted">{t('batch.done.none')}</p>}
          <div className="conv__actions">
            <Button variant="ghost" onClick={flow.reset}>
              {t('batch.done.another')}
            </Button>
          </div>
        </>
      )}

      {groups.map((g) => (
        <section className="bgroup" key={g.attention ? '__attention' : (g.format ?? '__nomatch')} data-testid={g.attention ? 'group-attention' : g.format === null ? 'group-nomatch' : 'group-format'}>
          <h3 className="bgroup__title">
            {g.attention ? t('batch.group.attention') : g.format === null ? t('batch.group.noMatch') : <Cell value={g.format} empty="—" />}
            <span className="muted tabular"> · {t(g.items.length === 1 ? 'batch.count.one' : 'batch.count.other', { n: nf.format(g.items.length) })}</span>
          </h3>
          <ul className="bfiles">
            {g.items.map((i) => (
              <BatchFileRow key={i.id} item={i} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function BatchFileRow({ item }: { item: BatchItem }) {
  const i18n = useI18n();
  const { t, code, lang } = i18n;
  const nf = new Intl.NumberFormat(lang);
  const flagRows = new Set(item.flags.map((f) => f.rowNumber)).size;
  return (
    <li className="bfile" data-status={item.status} data-testid="batch-file">
      <div className="bfile__main">
        <p className="bfile__name">
          <Cell value={item.file.name} />
        </p>
        {(item.status === 'noMatch' || item.status === 'needsAttention') && item.reason ? <p className="muted bfile__reason">{reasonText(i18n, item.reason)}</p> : null}
        {item.status === 'noMatch' && item.formatName ? <p className="muted bfile__reason">{t('batch.forFormat', { format: isolate(item.formatName) })}</p> : null}
        {item.status !== 'noMatch' && item.status !== 'needsAttention' && item.sourceName ? (
          <p className="muted bfile__meta tabular">
            <Cell value={item.sourceName} /> · {t('batch.rows', { rowsIn: nf.format(item.rowsIn ?? 0), rowsOut: nf.format(item.rowsOut ?? 0) })}
            {flagRows > 0 ? ` · ${t(flagRows === 1 ? 'batch.flagsCount.one' : 'batch.flagsCount.other', { n: nf.format(flagRows) })}` : ''}
          </p>
        ) : null}
        {item.flags.length > 0 ? (
          <details className="bfile__flags">
            <summary>{t(flagRows === 1 ? 'batch.flagsCount.one' : 'batch.flagsCount.other', { n: nf.format(flagRows) })}</summary>
            <ul>
              {item.flags.slice(0, FLAGS_LISTED).map((f, k) => (
                <li key={`${f.rowNumber}|${f.column}|${k}`} className="tabular">
                  {t('conv.review.row', { row: f.rowNumber })} · <bdi>{item.columnLabels[f.column] ?? f.column}</bdi> · {code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <StatusBadge status={item.status} />
    </li>
  );
}
