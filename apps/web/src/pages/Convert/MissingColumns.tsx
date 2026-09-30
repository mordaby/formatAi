// Required columns are missing and nothing in the file can stand in for them (SPEC 5 C: "missing required columns stop
// the run with a clear message"): the exact headers, and what to do about it.
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, InlineMessage } from '../../ui';
import { isolate } from './logic';

export interface MissingColumnsProps {
  sourceName: string;
  missing: readonly string[];
  onAnotherFile(): void;
}

export function MissingColumns({ sourceName, missing, onAnotherFile }: MissingColumnsProps) {
  const { t } = useI18n();
  const count = missing.length;
  return (
    <div data-testid="missing-columns">
      <InlineMessage
        tone="block"
        title={t('conv.missing.title')}
        todo={t('conv.missing.todo')}
        actions={
          <Button variant="secondary" onClick={onAnotherFile}>
            {t('conv.missing.another')}
          </Button>
        }
      >
        <p>{t(count === 1 ? 'conv.missing.text.one' : 'conv.missing.text.other', { source: isolate(sourceName), count })}</p>
        <ul className="chips" data-testid="missing-list">
          {missing.map((h) => (
            <li key={h}>
              <Cell value={h} />
            </li>
          ))}
        </ul>
      </InlineMessage>
    </div>
  );
}
