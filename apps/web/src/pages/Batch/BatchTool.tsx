// The several-files half of the Run screen (SPEC 5 D, 8.15, 11): the files the user dropped, one at a time in the worker, each matched
// to its own source (and converted into every format that source feeds); a zip of the converted files plus a summary sheet of flags.
// The page (`/convert`) owns the flow and the saved sources; this is only what is shown while there are files to run or results.
import { tiers, type Tier } from '@formatai/shared';
import { UpgradeButton } from '../../app/Upgrade';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, DropZone, InlineMessage, Progress } from '../../ui';
import { BatchResults, StatusBadge } from './BatchResults';
import type { AddResult, UseBatchFlow } from './useBatchFlow';

/** What happened to the files that were dropped but not taken: too many for the plan, or not a file we can convert. */
export function AddNotice({ notice, tier }: { notice: AddResult | null; tier: Tier }) {
  const { t } = useI18n();
  if (!notice) return null;
  const limits = tiers[tier];
  return (
    <>
      {notice.overLimit > 0 ? (
        <InlineMessage tone="warn">
          <p>{t('batch.limit', { n: limits.filesPerRun })}</p>
          {/* A registered user is told, in one line, what the next plan runs (no payment code in the MVP: the Upgrade panel). */}
          {tier === 'registered' ? (
            <p className="muted">
              {t('batch.paid.hint', { n: tiers.paid.filesPerRun })} <UpgradeButton variant="link" trigger="batch" />
            </p>
          ) : null}
        </InlineMessage>
      ) : null}
      {notice.skipped > 0 ? <InlineMessage tone="warn">{t('batch.skipped', { n: notice.skipped, mb: Math.round(limits.maxFileBytes / (1024 * 1024)) })}</InlineMessage> : null}
    </>
  );
}

export interface BatchToolProps {
  flow: UseBatchFlow;
  tier: Tier;
  notice: AddResult | null;
  /** More files dropped on the list (the page puts them through `flow.add` and keeps what that said). */
  onFiles(files: File[]): void;
}

export function BatchTool({ flow, tier, notice, onFiles }: BatchToolProps) {
  const { t, lang } = useI18n();
  const nf = new Intl.NumberFormat(lang);
  const { phase, items } = flow;

  if (phase === 'packing' || phase === 'done') return <BatchResults flow={flow} />;

  const running = phase === 'running';
  const progress = t('batch.progress', { done: Math.min(flow.done + 1, flow.total), total: flow.total });
  const count = (n: number): string => t(n === 1 ? 'batch.count.one' : 'batch.count.other', { n: nf.format(n) });

  return (
    <section className="conv__step" aria-label={t('batch.title')}>
      {!running ? (
        <DropZone
          label={t('batch.drop.label')}
          caption={t('batch.drop.caption', { n: flow.filesPerRun })}
          file={null}
          onFile={(file) => onFiles([file])}
          onFiles={onFiles}
          maxBytes={tiers[tier].maxFileBytes}
        />
      ) : (
        <div className="conv__progress">
          <Progress value={flow.total === 0 ? 0 : flow.done / flow.total} label={progress} />
          <p className="muted tabular" role="status" data-testid="batch-progress">
            {progress}
          </p>
        </div>
      )}
      <AddNotice notice={notice} tier={tier} />

      {items.length > 0 ? (
        <>
          <div className="batch__bar">
            <p className="muted tabular" data-testid="batch-count">
              {count(flow.total)}
            </p>
            {running ? (
              <Button variant="secondary" size="sm" onClick={flow.stop}>
                {t('batch.cancel')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={flow.clear}>
                {t('batch.clear')}
              </Button>
            )}
          </div>
          <ul className="bfiles" data-testid="batch-list">
            {items.map((i) => (
              <li className="bfile" key={i.id} data-status={i.status} data-testid="batch-file">
                <div className="bfile__main">
                  <p className="bfile__name">
                    <Cell value={i.file.name} />
                  </p>
                </div>
                {running ? (
                  <StatusBadge status={i.status} />
                ) : (
                  <Button variant="ghost" size="sm" icon="close" aria-label={t('batch.remove', { name: i.file.name })} onClick={() => flow.remove(i.id)} />
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!running ? (
        <div className="conv__actions">
          <Button variant="primary" disabled={items.length === 0} onClick={flow.run}>
            {t(items.length === 1 ? 'batch.run.one' : 'batch.run', { n: nf.format(items.length) })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
