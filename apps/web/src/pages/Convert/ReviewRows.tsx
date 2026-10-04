// The review before the file is written (SPEC 21 v5 item 5, issue #36). Flagged rows are shown BEFORE the output exists (when a
// source feeds several formats, each format has its own review and this says which one it is);
// for each the user picks: change the rule (the source's rules editor, then convert again), fix this row only (a one-off
// value edit, never saved to the rules), skip it, or keep it as it is. The engine applies these per-run decisions
// without touching the saved rules and lists them in the run summary.
import type { Flag } from '@formatai/engine';
import type { LearnResult, Rules } from '@formatai/shared';
import { useId, useState } from 'react';
import { Cell } from '../../components/Cell';
import { webConfig } from '../../config';
import { useI18n } from '../../i18n';
import type { RowInputCell } from '../../worker/convertApi';
import { Badge, Button, Icon } from '../../ui';
import { columnLabel, fixFields, isolate, tally, type Choices, type ReviewRow, type RowChoice } from './logic';
import type { Step, Target } from './useConvertFlow';

/** What the review needs of the conversion: its rules (columns are named from them) and, for "Format 2 of 3", the format's name. */
export type ReviewTarget = { rules: LearnResult | Rules } & Partial<Pick<Target, 'formatName'>>;

export interface ReviewRowsProps {
  target: ReviewTarget;
  /** "Format 2 of 3": set when the file is being made into several formats. */
  step: Step | null;
  rows: readonly ReviewRow[];
  rowInputs: Record<number, RowInputCell[]>;
  choices: Choices;
  onChoice(rowNumber: number, choice: RowChoice | null): void;
  onKeepAll(): void;
  onSkipAll(): void;
  onClear(): void;
  /** Opens the rules and comes back. Absent where the rules are already on screen (Result's "Try it on another file"): no button, and the hint says to edit them there. */
  onChangeRule?(): void;
  onCreate(): void;
}

export function ReviewRows({ target, step, rows, rowInputs, choices, onChoice, onKeepAll, onSkipAll, onClear, onChangeRule, onCreate }: ReviewRowsProps) {
  const { t, lang } = useI18n();
  const [fixing, setFixing] = useState<number | null>(null);
  const nf = new Intl.NumberFormat(lang);
  const shown = rows.slice(0, webConfig.convertReviewRows);
  const counts = tally(rows, choices);

  return (
    <section className="conv__step" aria-labelledby="conv-review-title" data-testid="review">
      <header className="conv__head">
        {step ? (
          <p className="conv__stepno" data-testid="review-step">
            {t('conv.review.for', { n: nf.format(step.n), total: nf.format(step.total), format: isolate(target.formatName ?? '') })}
          </p>
        ) : null}
        <h2 id="conv-review-title">{t('conv.review.title')}</h2>
        <p className="lead" data-testid="review-count">
          {t(rows.length === 1 ? 'conv.review.lead.one' : 'conv.review.lead.other', { n: nf.format(rows.length) })}
        </p>
        <p className="muted">{t('conv.review.explain')}</p>
      </header>

      <div className="review__bulk">
        <Button variant="secondary" size="sm" onClick={onKeepAll}>
          {t('conv.review.keepAll')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onSkipAll}>
          {t('conv.review.skipAll')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={Object.keys(choices).length === 0}>
          {t('conv.review.clear')}
        </Button>
        <p className="muted tabular review__tally" data-testid="review-tally">
          {t('conv.review.tally', { keep: counts.keep, skip: counts.skip, fix: counts.fix, open: counts.open })}
        </p>
      </div>

      <ul className="review">
        {shown.map((row) => (
          <RowCard
            key={row.rowNumber}
            target={target}
            row={row}
            cells={rowInputs[row.rowNumber] ?? []}
            choice={choices[row.rowNumber]}
            fixing={fixing === row.rowNumber}
            onFix={() => setFixing(row.rowNumber)}
            onCloseFix={() => setFixing((f) => (f === row.rowNumber ? null : f))}
            onChoice={(c) => onChoice(row.rowNumber, c)}
            onChangeRule={onChangeRule}
          />
        ))}
      </ul>
      {rows.length > shown.length ? <p className="muted">{t('conv.review.more', { n: nf.format(rows.length - shown.length) })}</p> : null}

      <div className="conv__actions">
        <Button variant="primary" onClick={onCreate}>
          {t('conv.review.create')}
        </Button>
        <p className="muted">{t(onChangeRule ? 'conv.review.rule.hint' : 'conv.review.rule.hint.here')}</p>
      </div>
    </section>
  );
}

interface RowCardProps {
  target: ReviewTarget;
  row: ReviewRow;
  cells: readonly RowInputCell[];
  choice: RowChoice | undefined;
  fixing: boolean;
  onFix(): void;
  onCloseFix(): void;
  onChoice(choice: RowChoice | null): void;
  onChangeRule: (() => void) | undefined;
}

function RowCard({ target, row, cells, choice, fixing, onFix, onCloseFix, onChoice, onChangeRule }: RowCardProps) {
  const { t, code } = useI18n();
  const decidedKey = choice ? (`conv.review.decided.${choice.action === 'override' ? 'fix' : choice.action}` as const) : null;
  return (
    <li className="rv" data-row={row.rowNumber} data-choice={choice?.action} data-testid="review-row">
      <div className="rv__head">
        <Icon name="alert" size={16} className="rv__icon" />
        <h3 className="rv__row tabular">{t('conv.review.row', { row: row.rowNumber })}</h3>
        {choice && decidedKey ? (
          <span className="rv__decided">
            <Badge tone={choice.action === 'skip' ? 'neutral' : 'verified'}>{t(decidedKey)}</Badge>
            <Button variant="link" onClick={() => onChoice(null)}>
              {t('conv.review.undo')}
            </Button>
          </span>
        ) : null}
      </div>

      <ul className="rv__flags">
        {row.flags.map((f, i) => (
          <li key={`${f.column}|${f.rule}|${i}`} className="rv__flag" data-testid="review-flag">
            <p className="rv__where tabular">
              <bdi className="sentence__name">{columnLabel(target.rules, f.column)}</bdi>
              {' · '}
              {f.value === null || f.value === '' ? <span className="muted">{t('conv.review.empty')}</span> : <Cell value={String(f.value)} />}
            </p>
            <p>{code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })}</p>
            {f.suggestion !== undefined ? (
              <p className="rv__suggestion tabular">{t('conv.review.suggestion', { value: isolate(String(f.suggestion)) })}</p>
            ) : null}
          </li>
        ))}
        {row.blocked ? (
          <li className="rv__flag" data-testid="review-blocked">
            <p>{t('conv.review.blocked', { column: isolate(columnLabel(target.rules, row.blocked.column)) })}</p>
          </li>
        ) : null}
      </ul>

      {fixing ? (
        <FixEditor row={row} cells={fixFields(row, cells)} onApply={(values) => (onChoice({ action: 'override', values }), onCloseFix())} onCancel={onCloseFix} />
      ) : (
        <div className="rv__actions" role="group" aria-label={t('conv.review.row', { row: row.rowNumber })}>
          {onChangeRule ? (
            <Button variant="secondary" size="sm" onClick={onChangeRule}>
              {t('conv.review.action.rule')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onFix} disabled={cells.length === 0}>
            {t('conv.review.action.fix')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onChoice({ action: 'skip' })} aria-pressed={choice?.action === 'skip'}>
            {t('conv.review.action.skip')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onChoice({ action: 'keep' })} aria-pressed={choice?.action === 'keep'}>
            {t('conv.review.action.keep')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Fix this row only: the input values of the row, edited for this file. A flag's suggestion is one click away. */
function FixEditor({ row, cells, onApply, onCancel }: { row: ReviewRow; cells: readonly RowInputCell[]; onApply(values: Record<string, string>): void; onCancel(): void }) {
  const { t } = useI18n();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(cells.map((c) => [c.columnId, c.value === null ? '' : String(c.value)])));
  const suggestionFor = (columnId: string): Flag['suggestion'] => row.flags.find((f) => f.column === columnId && f.suggestion !== undefined)?.suggestion;
  return (
    <form
      className="rv__fix"
      aria-label={t('conv.review.fix.title', { row: row.rowNumber })}
      onSubmit={(e) => {
        e.preventDefault();
        onApply(values);
      }}
    >
      <p className="rv__fix-title">{t('conv.review.fix.title', { row: row.rowNumber })}</p>
      <p className="field__hint">{t('conv.review.fix.hint')}</p>
      <div className="rv__fields">
        {cells.map((c) => {
          const suggestion = suggestionFor(c.columnId);
          const fieldId = `${id}-${c.columnId}`;
          return (
            <div className="field" key={c.columnId}>
              <label className="field__label" htmlFor={fieldId}>
                <Cell value={c.header} />
              </label>
              <div className="rv__field-row">
                <input id={fieldId} className="input" dir="auto" value={values[c.columnId] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [c.columnId]: e.target.value }))} />
                {suggestion !== undefined ? (
                  <Button variant="secondary" size="sm" onClick={() => setValues((v) => ({ ...v, [c.columnId]: String(suggestion) }))}>
                    {t('conv.review.fix.suggestion', { value: String(suggestion) })}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="rv__actions">
        <Button variant="primary" size="sm" type="submit">
          {t('conv.review.fix.apply')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('conv.review.fix.cancel')}
        </Button>
      </div>
    </form>
  );
}
