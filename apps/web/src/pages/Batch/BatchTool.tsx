// The several-files half of the Run screen (SPEC 5 D, 8.15, 11): the files the user dropped, one at a time in the worker, each matched
// to its own source (and converted into every format that source feeds); a zip of the converted files plus a summary sheet of flags.
// The page (`/convert`) owns the flow and the saved sources; this is only what is shown while there are files to run or results.
import { tiers, type Tier } from '@formatai/shared';
import { useId, useState } from 'react';
import { UpgradeButton } from '../../app/Upgrade';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { useTrack } from '../../services';
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
  if (phase === 'choosing') return <BatchChooseFormats flow={flow} />;

  // Every file is read (matched) before any is converted, so the batch can ask its one question first (SPEC 5 D).
  const matching = phase === 'matching';
  const running = phase === 'running' || matching;
  const progress = matching
    ? t('batch.matching', { done: Math.min(flow.matched + 1, flow.total), total: flow.total })
    : t('batch.progress', { done: Math.min(flow.done + 1, flow.total), total: flow.total });
  const share = flow.total === 0 ? 0 : (matching ? flow.matched : flow.done) / flow.total;
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
          <Progress value={share} label={progress} />
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

/**
 * The batch's one question (SPEC 5 D, owner 2026-10-08): some of the files can be made into several formats, so the user ticks the formats to
 * make - none is ticked in advance, with an "All" toggle - and each file is made into the chosen formats it fits. "Back" converts nothing.
 */
function BatchChooseFormats({ flow }: { flow: UseBatchFlow }) {
  const { t, lang } = useI18n();
  const track = useTrack();
  const id = useId();
  const nf = new Intl.NumberFormat(lang);
  const all = flow.choices.map((c) => c.formatId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const allPicked = picked.size === all.length;
  const toggle = (formatId: string): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(formatId)) next.delete(formatId);
      else next.add(formatId);
      return next;
    });

  return (
    <section className="conv__step" aria-labelledby={`${id}-title`} data-testid="batch-choose-formats">
      <h2 id={`${id}-title`}>{t('batch.choose.title')}</h2>
      <p className="lead">{t('batch.choose.lead')}</p>
      <fieldset className="fmts">
        <legend className="visually-hidden">{t('conv.formats.legend')}</legend>
        <label className="check fmts__all">
          <input
            type="checkbox"
            checked={allPicked}
            ref={(el) => {
              if (el) el.indeterminate = picked.size > 0 && !allPicked;
            }}
            onChange={() => setPicked(allPicked ? new Set() : new Set(all))}
          />
          <span>{t('conv.formats.all')}</span>
        </label>
        <ul className="fmts__list">
          {flow.choices.map((c) => (
            <li key={c.formatId}>
              <label className="check">
                <input type="checkbox" checked={picked.has(c.formatId)} onChange={() => toggle(c.formatId)} />
                <span>
                  <Cell value={c.formatName} />
                  <span className="muted tabular"> · {t(c.files === 1 ? 'batch.count.one' : 'batch.count.other', { n: nf.format(c.files) })}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="conv__actions">
        <Button
          variant="primary"
          disabled={picked.size === 0}
          onClick={() => {
            // SPEC 14.1 `formats_chosen` for the batch's one question: the formats offered and the ones ticked, counts only (owner, 2026-10-08: none is ticked).
            track('formats_chosen', { offered: all.length, chosen: picked.size, all: allPicked, batch: true });
            flow.choose(all.filter((x) => picked.has(x)));
          }}
        >
          {t('batch.choose.continue')}
        </Button>
        <Button variant="ghost" onClick={flow.cancelChoice}>
          {t('batch.choose.back')}
        </Button>
      </div>
      {picked.size === 0 ? <p className="muted">{t('conv.formats.none')}</p> : null}
    </section>
  );
}
