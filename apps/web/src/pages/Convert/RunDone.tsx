// The run result (SPEC 16.1 screen 6): the download, then the report of the run (`RunReport`: the summary, the flags and the first
// rows of the file). Nothing here leaves the browser.
import { Link } from 'react-router-dom';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { isolate } from './logic';
import { NewColumns } from './NewColumns';
import { RunReport } from './RunReport';
import type { Finished, NewColumnsNotice, Target } from './useConvertFlow';

export interface RunDoneProps {
  target: Target;
  finished: Finished;
  aliasNotSaved: boolean;
  /** "New column in this file" (SPEC 8.15), when there is one to mention. */
  notice: NewColumnsNotice | null;
  onDownload(): void;
  onAnother(): void;
  onDismissNotice(): void;
  onAddColumn(format: { conversionId: string; formatId: string }): void;
}

export function RunDone({ target, finished, aliasNotSaved, notice, onDownload, onAnother, onDismissNotice, onAddColumn }: RunDoneProps) {
  const { t } = useI18n();

  return (
    <section className="conv__step" aria-labelledby="conv-done-title" data-testid="run-done">
      <header className="conv__head">
        <h2 id="conv-done-title">{t('conv.done.title')}</h2>
        <p className="muted">{t('conv.done.source', { source: isolate(target.sourceName), format: isolate(target.formatName) })}</p>
      </header>

      <div className="conv__actions">
        <Button variant="primary" icon="file" onClick={onDownload}>
          {t('conv.done.download')}
        </Button>
        <Button variant="ghost" onClick={onAnother}>
          {t('conv.done.another')}
        </Button>
      </div>
      <p className="muted conv__name" data-testid="output-name">
        <Cell value={finished.fileName} />
      </p>
      {aliasNotSaved ? <p className="muted">{t('conv.map.aliasNotSaved')}</p> : null}
      {notice ? <NewColumns notice={notice} onDismiss={onDismissNotice} onAdd={onAddColumn} /> : null}

      <RunReport rules={target.rules} finished={finished} />

      <p className="conv__foot">
        <Link to="/formats">{t('conv.done.formats')}</Link>
      </p>
    </section>
  );
}
