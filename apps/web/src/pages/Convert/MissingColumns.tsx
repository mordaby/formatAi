// Required columns are missing and nothing in the file can stand in for them (SPEC 5 C: "missing required columns stop
// the run with a clear message"): the exact headers, every format this affects (SPEC 8.15), and what to do about it.
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, InlineMessage } from '../../ui';
import { FormatChips } from './FormatChips';
import { isolate } from './logic';

export interface MissingColumnsProps {
  sourceName: string;
  /** The names of every format this source feeds (in scope): none of them can be made from this file. */
  formats: readonly string[];
  missing: readonly string[];
  onAnotherFile(): void;
}

export function MissingColumns({ sourceName, formats, missing, onAnotherFile }: MissingColumnsProps) {
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
        <FormatChips label="conv.affects" formats={formats} testId="affected-formats" />
      </InlineMessage>
    </div>
  );
}
