// The ambiguity question (SPEC 8.11, 16.1 screen 4, 21 v12 item 11): the example fits more than one rule for a column - "always '00', or the
// first 2 digits of Employee number?" - and only the user knows which. Asked once, on the column's own line in the Columns section: quiet (no
// amber: nothing differs yet), no modal. Each answer is a button that says its rule in the rules map's own words, and applies it. "Not sure
// yet" keeps what the free engine built (the data reading) with the check that flags a run-time row where the readings differ - the check is in
// the Checks section, visible and deletable - and folds the question into one line. The day/month order of a text date (SPEC 21 v12 item 16)
// is the same question without a check: its answers say the order with an example ("day/month (31/01)").
import type { AmbiguousColumn } from '@formatai/engine';
import { useMemo } from 'react';
import type { EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { Marked, Named } from './Named';
import { readingParts } from './readingText';
import { Sentence } from './Sentence';

export interface ReadingQuestionProps {
  column: AmbiguousColumn;
  rules: EditableRules;
  /** "Not sure yet" was pressed: the question is one quiet line, and can be opened again. */
  unsure: boolean;
  /** The deep analysis is working on the rules: nothing can be answered meanwhile. */
  disabled: boolean;
  onAnswer(index: number): void;
  onUnsure(): void;
  onReopen(): void;
}

export function ReadingQuestion({ column, rules, unsure, disabled, onAnswer, onUnsure, onReopen }: ReadingQuestionProps) {
  const { t, lang } = useI18n();
  // Each reading in the map's words; one that cannot be applied to these rules (the rules read its column another way) is not offered.
  const choices = useMemo(
    () => column.readings.map((_, index) => ({ index, parts: readingParts(rules, column, index, lang) })).filter((c) => c.parts !== null),
    [column, rules, lang],
  );
  const kept = choices.find((c) => c.index === column.defaultReading);
  const other = choices.find((c) => c.index !== column.defaultReading);
  // A question needs two answers.
  if (choices.length < 2 || !kept || !other) return null;

  // The day/month order of a date column (SPEC 21 v12 item 16): the question names the date column, and with no check to flag a row, "Not sure
  // yet" says only what is kept for now - never that a row would be flagged.
  const dates = column.readings[column.defaultReading]?.kind === 'dayMonthOrder';
  const dateColumn = column.readings[column.defaultReading]?.columns[0] ?? column.header;

  if (unsure) {
    return (
      <div className="map-line__ask" data-testid="reading-question" data-column={column.header} data-state="unsure">
        <p data-testid="reading-unsure">
          <Marked id={column.check === null ? 'ask.kept.plain' : 'ask.kept'} nodes={{ rule: <Sentence parts={kept.parts!} />, other: <Sentence parts={other.parts!} /> }} />
        </p>
        <div className="map-line__actions">
          <Button variant="link" size="sm" onClick={onReopen}>
            {t('ask.reopen')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="map-line__ask" data-testid="reading-question" data-column={column.header} data-state="open">
      <p className="map-line__ask-question">
        {dates ? <Named id="ask.question.dayMonthOrder" name={dateColumn} /> : <Named id="ask.question" name={column.header} />}
      </p>
      <p className="muted">{t('ask.lead')}</p>
      <div className="map-line__ask-choices" role="group" aria-label={t('ask.group', { column: column.header })}>
        {choices.map((c) => (
          <Button key={c.index} variant="secondary" size="sm" disabled={disabled} onClick={() => onAnswer(c.index)} data-reading={column.readings[c.index]!.kind}>
            <Sentence parts={c.parts!} />
          </Button>
        ))}
        <Button variant="link" size="sm" disabled={disabled} onClick={onUnsure}>
          {t('ask.unsure')}
        </Button>
      </div>
    </div>
  );
}
