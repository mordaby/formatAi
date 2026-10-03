// Batch (SPEC 5 D, 8.15, 11): many files, one at a time in the worker, each matched to its own source (and converted into every
// format that source feeds); a zip of the converted files plus a summary sheet of flags. A paid feature: everyone can see what
// it does; others get an Upgrade prompt.
import { tiers, type Tier } from '@formatai/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UpgradeButton } from '../../app/Upgrade';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, Icon, InlineMessage, Progress, Spinner } from '../../ui';
import { AccountGate } from '../Convert/Gate';
import { BatchDropZone } from './BatchDropZone';
import { BatchResults, StatusBadge } from './BatchResults';
import { useBatchFlow, type AddResult } from './useBatchFlow';

export default function BatchPage() {
  const { t } = useI18n();
  return (
    <main id="main" className="page page--convert" tabIndex={-1}>
      <section className="tool">
        <div className="view convert">
          <header className="tool__head">
            <h1>{t('batch.title')}</h1>
            <p className="lead">{t('batch.lead')}</p>
          </header>
          <ul className="what">
            {(['batch.what.1', 'batch.what.2', 'batch.what.3'] as const).map((key) => (
              <li key={key}>
                <Icon name="check" size={16} />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <AccountGate title="batch.wall.title" text="batch.wall.text">
            {(user) => (tiers[user.tier].filesPerRun > 1 ? <BatchTool tier={user.tier} /> : <UpgradePrompt />)}
          </AccountGate>
        </div>
      </section>
    </main>
  );
}

/** Not on a paid plan: what Batch is, what the plan allows, and a way to upgrade (SPEC 11: no payment code in the MVP). */
function UpgradePrompt() {
  const { t } = useI18n();
  return (
    <InlineMessage
      tone="info"
      title={t('batch.paid.title')}
      actions={
        <>
          <UpgradeButton variant="primary" />
          <Link className="btn btn--ghost" to="/convert">
            {t('batch.paid.single')}
          </Link>
        </>
      }
    >
      {t('batch.paid.text', { n: tiers.paid.filesPerRun })}
    </InlineMessage>
  );
}

function BatchTool({ tier }: { tier: Tier }) {
  const { t, lang } = useI18n();
  const flow = useBatchFlow({ tier, enabled: true });
  const [notice, setNotice] = useState<AddResult | null>(null);
  const nf = new Intl.NumberFormat(lang);
  const { sources, phase, items } = flow;

  if (sources.status === 'loading') {
    return (
      <p className="muted conv__wait" role="status">
        <Spinner size={16} /> {t('conv.loading')}
      </p>
    );
  }
  if (sources.status === 'error') return <InlineMessage tone="error">{t('conv.sourcesError')}</InlineMessage>;
  if (sources.entries.length === 0) {
    return (
      <InlineMessage
        tone="info"
        title={t('conv.noSources.title')}
        actions={
          <Link className="btn btn--primary" to="/">
            {t('conv.noSources.action')}
          </Link>
        }
      >
        {t('conv.noSources.text')}
      </InlineMessage>
    );
  }

  if (phase === 'packing' || phase === 'done') return <BatchResults flow={flow} />;

  const running = phase === 'running';
  const progress = t('batch.progress', { done: Math.min(flow.done + 1, flow.total), total: flow.total });
  const count = (n: number): string => t(n === 1 ? 'batch.count.one' : 'batch.count.other', { n: nf.format(n) });

  return (
    <section className="conv__step" aria-label={t('batch.title')}>
      {!running ? (
        <BatchDropZone
          files={items.length}
          limit={flow.filesPerRun}
          onFiles={(files) => {
            const result = flow.add(files);
            setNotice(result.skipped > 0 || result.overLimit > 0 ? result : null);
          }}
        />
      ) : (
        <div className="conv__progress">
          <Progress value={flow.total === 0 ? 0 : flow.done / flow.total} label={progress} />
          <p className="muted tabular" role="status" data-testid="batch-progress">
            {progress}
          </p>
        </div>
      )}
      {notice?.overLimit ? <InlineMessage tone="warn">{t('batch.limit', { n: flow.filesPerRun })}</InlineMessage> : null}
      {notice?.skipped ? <InlineMessage tone="warn">{t('batch.skipped', { n: notice.skipped, mb: Math.round(tiers[tier].maxFileBytes / (1024 * 1024)) })}</InlineMessage> : null}

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
