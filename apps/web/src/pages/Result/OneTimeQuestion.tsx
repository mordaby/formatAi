// "A one-time change, or a rule we missed?" (SPEC 8.11, 16.1 screen 4, 21 v12 item 20; owner decision 2026-10-05). A part of the column's rule
// explains exactly one row of the example, singled out by its ID, an exact amount or date, or its place in the file - the kind of part the AI
// step writes for a row that was edited by hand once. Asked on the column's own line, with the same look as the ambiguity question (quiet,
// no amber, no modal): "Row 54: Discount is 0 instead of Amount × 0.1, rounded to 2 decimals." The row's own values are shown here, read from
// the learn on this computer; nothing is sent. Three answers: a one-time change (the part goes, the row is listed as one that doesn't follow
// the rule), a rule (it stays), not sure (it stays, with a check that flags a later row it applies to - the question folds into one line).
//
// The second kind (owner amendment, 2026-10-06), a list copied from the example, in the same place and look: "Account Manager: is this the
// rule?" - "We learned Account Manager as a list taken from your example: one value for each Account (40 entries)." Neutral, no cell value.
// Two answers: "Yes, that's the rule" (nothing changes) and "No, it was a one-time edit" (the column needs your input).
import type { CopiedListQuestion, OneTimeQuestion as Question } from '@formatai/engine';
import type { PayloadCell } from '@formatai/shared';
import { useMemo } from 'react';
import { Cell } from '../../components/Cell';
import type { EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { formatPreview } from './formatPreview';
import { Marked } from './Named';
import { restParts } from './oneTimeText';
import { Sentence } from './Sentence';

export interface OneTimeQuestionProps {
  question: Question;
  rules: EditableRules;
  /** `unsure`: "Not sure" was answered - one quiet line, which can be opened again. */
  state: 'open' | 'unsure';
  /** The deep analysis is working on the rules: nothing can be answered meanwhile. */
  disabled: boolean;
  onOnce(): void;
  onRule(): void;
  onUnsure(): void;
  onReopen(): void;
}

export function OneTimeQuestion({ question: q, rules, state, disabled, onOnce, onRule, onUnsure, onReopen }: OneTimeQuestionProps) {
  const { t, lang } = useI18n();
  const rest = useMemo(() => (q.kind === 'copiedList' ? null : restParts(rules, q, lang)), [rules, q, lang]);
  if (q.kind === 'copiedList') return <CopiedList question={q} disabled={disabled} onOnce={onOnce} onRule={onRule} />;
  if (rest === null) return null;
  const language = rules.output.language;
  const format = rules.output.columns.find((c) => c.header === q.header)?.format;
  const show = (v: PayloadCell): string => (v === null || v === '' ? t('unfinished.empty') : formatPreview(format, v as never, language));
  const row = <span className="tabular">{q.row}</span>;
  const column = <bdi className="sentence__name">{q.header}</bdi>;
  // The value that singles the row out, as the input file has it (a number in the user's own grouping).
  const key = q.key === undefined || q.key === null ? '' : typeof q.key === 'number' ? q.key.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US', { maximumFractionDigits: 10 }) : String(q.key);

  if (state === 'unsure') {
    return (
      <div className="map-line__ask" data-testid="one-time-question" data-column={q.header} data-row={q.row} data-state="unsure">
        <p data-testid="one-time-unsure">
          <Marked id={q.check === null ? 'oneTime.kept.plain' : 'oneTime.kept'} nodes={{ row, column }} />
        </p>
        <div className="map-line__actions">
          <Button variant="link" size="sm" onClick={onReopen}>
            {t('oneTime.reopen')}
          </Button>
        </div>
      </div>
    );
  }

  const by =
    q.by === 'position' ? (
      <Marked id="oneTime.by.position" nodes={{ inputRow: <span className="tabular">{q.inputRow}</span> }} />
    ) : (
      <Marked id={`oneTime.by.${q.by}`} nodes={{ by: <bdi className="sentence__name">{q.byColumn ?? ''}</bdi>, key: <Cell value={key} /> }} />
    );
  return (
    <div className="map-line__ask" data-testid="one-time-question" data-column={q.header} data-row={q.row} data-state="open">
      <p className="map-line__ask-question">
        <Marked id="oneTime.question" nodes={{ row, column, value: <Cell value={show(q.value)} />, rule: <Sentence parts={rest} /> }} />
      </p>
      <p className="muted" data-testid="one-time-values">
        {by} <Marked id="oneTime.values" nodes={{ value: <Cell value={show(q.value)} />, rest: <Cell value={show(q.rest)} /> }} />
      </p>
      <div className="map-line__ask-choices" role="group" aria-label={t('oneTime.group', { row: q.row, column: q.header })}>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onOnce} data-answer="once">
          {t('oneTime.once')}
        </Button>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onRule} data-answer="rule">
          {t('oneTime.rule')}
        </Button>
        <Button variant="link" size="sm" disabled={disabled} onClick={onUnsure} data-answer="unsure">
          {t('oneTime.unsure')}
        </Button>
      </div>
    </div>
  );
}

/** A list copied from the example: the question, what was learned (the key column and the entry count, no value), and the two answers. */
function CopiedList({ question: q, disabled, onOnce, onRule }: { question: CopiedListQuestion; disabled: boolean; onOnce(): void; onRule(): void }) {
  const { t, lang } = useI18n();
  const column = <bdi className="sentence__name">{q.header}</bdi>;
  const entries = <span className="tabular">{q.entries.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}</span>;
  return (
    <div className="map-line__ask" data-testid="one-time-question" data-column={q.header} data-kind="copiedList" data-state="open">
      <p className="map-line__ask-question">
        <Marked id="oneTime.list.question" nodes={{ column }} />
      </p>
      <p className="muted" data-testid="one-time-values">
        <Marked id="oneTime.list.detail" nodes={{ column, key: <bdi className="sentence__name">{q.keyColumn}</bdi>, entries }} />
      </p>
      <div className="map-line__ask-choices" role="group" aria-label={t('oneTime.list.group', { column: q.header })}>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onRule} data-answer="rule">
          {t('oneTime.list.rule')}
        </Button>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onOnce} data-answer="once">
          {t('oneTime.list.once')}
        </Button>
      </div>
    </div>
  );
}
