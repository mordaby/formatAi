// "Try it on another file" (SPEC 5 A step 7, 21 v11): a quiet panel under the Result screen. The rules as they are on screen - edits
// included, saved or not - run on one more file in the worker, and what comes back is what a saved conversion shows: the report
// (rows, flagged rows, the first rows of the file), the review of flagged rows before the file is written, and the exact columns
// the file lacks. For everyone, one file at a time; nothing is saved and nothing leaves the computer. A visitor sees the same
// result (the preview is the free tier's rows) and is asked to sign in only to download it (SPEC 11).
import { tiers, type Tier } from '@formatai/shared';
import { useId } from 'react';
import { Cell } from '../../components/Cell';
import { webConfig } from '../../config';
import type { EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, DropZone, InlineMessage, Spinner } from '../../ui';
import { convertErrorText } from '../Convert/errors';
import { MissingColumns } from '../Convert/MissingColumns';
import { ReviewRows } from '../Convert/ReviewRows';
import { RunReport } from '../Convert/RunReport';
import { useTryFile } from './useTryFile';

export interface TryAnotherFileProps {
  /** The rules as they are on screen right now: read when a file is dropped (or run again), so an edit that is not saved yet is run too. */
  getRules(): EditableRules;
  tier: Tier;
  /** A visitor cannot download (SPEC 11): "Download" asks them to sign in instead. */
  onSignIn(): void;
}

export function TryAnotherFile({ getRules, tier, onSignIn }: TryAnotherFileProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const titleId = useId();
  const limits = tiers[tier];
  // The free tier's rows on screen (SPEC 11); a plan with no limit shows the Convert screen's.
  const previewRows = limits.previewRows === null ? webConfig.convertPreviewRows : Math.min(limits.previewRows, webConfig.convertPreviewRows);
  const flow = useTryFile({ maxBytes: limits.maxFileBytes, previewRows });
  const { phase, file } = flow;
  const busy = phase.kind === 'running' || phase.kind === 'writing';

  return (
    <section className="try" aria-labelledby={titleId} data-testid="try-file">
      <header className="try__head">
        <h2 id={titleId}>{t('try.title')}</h2>
        <p className="muted">{t('try.lead')}</p>
      </header>

      <DropZone
        label={t('try.drop.label')}
        caption={t('try.drop.caption')}
        file={file}
        info={file ? { status: 'ready', rows: null, columns: null } : undefined}
        onFile={(next) => flow.start(next, getRules())}
        onClear={flow.reset}
        maxBytes={limits.maxFileBytes}
        disabled={busy}
      />

      {busy ? (
        <p className="muted conv__wait" role="status">
          <Spinner size={16} /> {t(phase.kind === 'running' ? 'conv.running' : 'conv.writing')}
        </p>
      ) : null}

      {phase.kind === 'review' ? (
        // (no "Change the rule" here: the rules are on this screen, so the hint says to edit them above and run again)
        <ReviewRows
          target={{ rules: phase.rules }}
          step={null}
          rows={phase.rows}
          rowInputs={phase.rowInputs}
          choices={phase.choices}
          onChoice={flow.setChoice}
          onKeepAll={flow.keepAll}
          onSkipAll={flow.skipAll}
          onClear={flow.clearChoices}
          onCreate={flow.create}
        />
      ) : null}

      {phase.kind === 'done' ? (
        <div className="conv__step" data-testid="try-done">
          <div className="conv__actions">
            <Button variant="secondary" icon="file" onClick={limits.fullDownload ? flow.download : onSignIn}>
              {t('conv.done.download')}
            </Button>
          </div>
          {limits.fullDownload ? null : <p className="muted">{t('try.signIn', { n: previewRows })}</p>}
          <p className="muted conv__name" data-testid="try-output-name">
            <Cell value={phase.finished.fileName} />
          </p>
          <RunReport rules={phase.rules} finished={phase.finished} />
        </div>
      ) : null}

      {phase.kind === 'missing' ? <MissingColumns missing={phase.missing} onAnotherFile={flow.reset} /> : null}

      {phase.kind === 'error' ? (
        <InlineMessage tone="error">{phase.error.kind === 'invalidRules' ? t('try.error.rules') : convertErrorText(i18n, phase.error)}</InlineMessage>
      ) : null}

      {file && (phase.kind === 'done' || phase.kind === 'review' || phase.kind === 'missing' || phase.kind === 'error') ? (
        // After an edit above: the same file again, with the rules as they are now.
        <p>
          <Button variant="link" onClick={() => flow.start(file, getRules())}>
            {t('try.again')}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
