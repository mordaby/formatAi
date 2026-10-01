// The small form kit the editor panels are built from: labelled fields, choices, and the plain-words problem list.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ColumnType } from '@formatai/shared';
import type { ApplyActionOptions, ActionResult, EditableRules, EditAction, EditProblem, ExampleInputColumn } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { Button } from '../../ui';

/** What every editor panel needs of the editor: the current rules and a way to change them. */
export interface EditorCtx {
  rules: EditableRules;
  apply(action: EditAction, options?: ApplyActionOptions): ActionResult;
  /** Bumped by every change of the rules (undo and redo included). */
  rev: number;
  /** The newest revision right now (`rev` is the one this render saw). */
  currentRev(): number;
  /** The output's language (month names in previews). */
  language: 'he' | 'en';
  /**
   * The columns of the example input that no rule declares yet, and the ones typed in (`addInput`): every "source column"
   * dropdown offers them, and an edit that uses one declares it first, in the same undoable step.
   */
  available: readonly ExampleInputColumn[];
  /** No example input is known here (a saved source without its example files): a column can be typed in by its header. */
  canTypeInput: boolean;
  /** Remembers a column the user typed in by its header; returns the id a rule uses to read it (the column's own, when it is already declared). */
  addInput(column: ExampleInputColumn): string;
}

// ---------- problems, in the user's language ----------

const PROBLEM_KEYS: Record<EditProblem['code'], MessageKey> = {
  unknownColumn: 'problem.unknownColumn',
  noSuchItem: 'problem.noSuchItem',
  emptyHeader: 'problem.emptyHeader',
  duplicateHeader: 'problem.duplicateHeader',
  typeMismatch: 'problem.typeMismatch',
  tooManyTerms: 'problem.tooManyTerms',
  tooFewTerms: 'problem.tooFewTerms',
  badOperators: 'problem.badOperators',
  badValue: 'problem.badValue',
  duplicateKey: 'problem.duplicateKey',
  noGroup: 'problem.noGroup',
  formula: 'problem.formula',
  json: 'problem.json',
  schema: 'problem.schema',
  reference: 'problem.reference',
  rule: 'problem.rule',
  locked: 'problem.locked',
};

/** Problems whose plain sentence is not enough: the checker's own (English) words follow, as a detail. */
const WITH_DETAIL: ReadonlySet<EditProblem['code']> = new Set(['formula', 'json', 'schema', 'reference', 'rule', 'badValue', 'typeMismatch', 'duplicateKey']);

export function ProblemList({ problems }: { problems: readonly EditProblem[] }) {
  const { t } = useI18n();
  if (problems.length === 0) return null;
  return (
    <ul className="problems" role="alert">
      {problems.map((p, i) => (
        <li key={i}>
          <span>{t(PROBLEM_KEYS[p.code], { column: p.column ?? '' })}</span>
          {WITH_DETAIL.has(p.code) && (
            <span className="problems__detail" dir="ltr">
              {p.path ? `${p.path}: ` : ''}
              {p.message}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Applies edits and keeps the problems of the last one, so a form can say what is wrong next to the field.
 * `onExternal` runs when the rules changed by something other than this form's own edits (undo, redo, another
 * panel): the form should read its fields from the rules again.
 */
export function useEdit(ctx: EditorCtx, onExternal?: () => void): { run(action: EditAction, options?: ApplyActionOptions): boolean; problems: EditProblem[]; clear(): void } {
  const [problems, setProblems] = useState<EditProblem[]>([]);
  const { apply, currentRev, rev } = ctx;
  const own = useRef(rev);
  const external = useRef(onExternal);
  external.current = onExternal;
  useEffect(() => {
    if (rev !== own.current) {
      own.current = rev;
      setProblems([]);
      external.current?.();
    }
  }, [rev]);
  const run = useCallback(
    (action: EditAction, options?: ApplyActionOptions): boolean => {
      const result = apply(action, options);
      if (result.ok) own.current = currentRev();
      setProblems(result.ok ? [] : result.problems);
      return result.ok;
    },
    [apply, currentRev],
  );
  const clear = useCallback(() => setProblems([]), []);
  return { run, problems, clear };
}

// ---------- fields ----------

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  className?: string | undefined;
  children(id: string, describedBy: string | undefined): ReactNode;
}

function FieldShell({ label, hint, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={['field', className ?? ''].filter(Boolean).join(' ')}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, hintId)}
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  label: ReactNode;
  value: string;
  onChange(value: string): void;
  hint?: ReactNode;
  placeholder?: string;
  /** `ltr` for formulas and codes. Default `auto`: the value's own first strong character decides. */
  dir?: 'auto' | 'ltr';
  mono?: boolean;
  invalid?: boolean;
  className?: string;
}

export function TextField({ label, value, onChange, hint, placeholder, dir = 'auto', mono, invalid, className }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint} className={className}>
      {(id, describedBy) => (
        <input
          id={id}
          className={['input', mono ? 'input--mono' : ''].filter(Boolean).join(' ')}
          type="text"
          dir={dir}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </FieldShell>
  );
}

export interface NumberFieldProps {
  label: ReactNode;
  /** `undefined` = empty. */
  value: number | undefined;
  onChange(value: number | undefined): void;
  min?: number;
  max?: number;
  hint?: ReactNode;
  className?: string;
  /** No visible label (the label still names the control for assistive tech). */
  hideLabel?: boolean;
}

export function NumberField({ label, value, onChange, min, max, hint, className, hideLabel }: NumberFieldProps) {
  return (
    <FieldShell label={hideLabel ? <span className="visually-hidden">{label}</span> : label} hint={hint} className={className}>
      {(id, describedBy) => (
        <input
          id={id}
          className="input input--number"
          type="number"
          dir="ltr"
          inputMode="numeric"
          min={min}
          max={max}
          value={value === undefined ? '' : value}
          aria-describedby={describedBy}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') onChange(undefined);
            else {
              const n = Number(raw);
              if (Number.isFinite(n)) onChange(n);
            }
          }}
        />
      )}
    </FieldShell>
  );
}

export interface Option<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps<V extends string> {
  label: ReactNode;
  value: V | '';
  options: readonly Option<V>[];
  onChange(value: V): void;
  /** Shown as a first, empty choice when nothing is chosen. */
  placeholder?: string;
  hint?: ReactNode;
  className?: string;
  /** No visible label (the label still names the control for assistive tech). */
  hideLabel?: boolean;
}

export function SelectField<V extends string>({ label, value, options, onChange, placeholder, hint, className, hideLabel }: SelectFieldProps<V>) {
  return (
    <FieldShell label={hideLabel ? <span className="visually-hidden">{label}</span> : label} hint={hint} className={className}>
      {(id, describedBy) => (
        <select id={id} className="input input--select" dir="auto" value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value as V)}>
          {placeholder !== undefined && value === '' ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange(checked: boolean): void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" className="check__box" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="check__label">
        {label}
      </label>
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

export interface ChoiceGroupProps<V extends string> {
  label: ReactNode;
  value: V | undefined;
  options: readonly Option<V>[];
  onChange(value: V): void;
  /** `chips` = the wrapping pill buttons of "How is it made?"; `radios` = plain radio buttons in a row. */
  variant?: 'chips' | 'radios';
}

/** One choice out of a few: real radio inputs (keyboard and screen readers work as they should), styled as chips or plain radios. */
export function ChoiceGroup<V extends string>({ label, value, options, onChange, variant = 'radios' }: ChoiceGroupProps<V>) {
  const id = useId();
  return (
    <fieldset className={`choices choices--${variant}`}>
      <legend className="field__label">{label}</legend>
      <div className="choices__list">
        {options.map((o) => {
          const inputId = `${id}-${o.value}`;
          return (
            <span className="choice" key={o.value}>
              <input
                id={inputId}
                className="choice__input"
                type="radio"
                name={id}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              <label className="choice__label" htmlFor={inputId}>
                {o.label}
              </label>
            </span>
          );
        })}
      </div>
    </fieldset>
  );
}

export function FormSection({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['fsection', className ?? ''].filter(Boolean).join(' ')}>
      {title ? <h3 className="fsection__title">{title}</h3> : null}
      {children}
    </section>
  );
}

// ---------- a source column: the dropdown, and typing in a column of the input file that we have not seen ----------

const OTHER = '#other';
/** What a typed-in column can hold (ColumnType is wider than a person needs here). */
const TYPED_TYPES: readonly ColumnType[] = ['text', 'integer', 'decimal', 'idLike', 'date'];

export interface SourceFieldProps {
  ctx: EditorCtx;
  label: ReactNode;
  /** The chosen option's value. */
  value: string;
  /** The choices (built from `sourceOptions(rules, { exampleInput: ctx.available })`), plus any of the caller's own. */
  options: readonly Option[];
  /** `typed` is set when the value is a column the user has just typed in (its type is what they said). */
  onChange(value: string, typed?: ExampleInputColumn): void;
  /** Put in front of a typed-in column's id to make an option's value (a caller whose values are "col:<id>"). */
  valuePrefix?: string;
  hideLabel?: boolean;
  className?: string;
}

/**
 * A "which input column" dropdown. Without example files (ctx.canTypeInput) it also offers "Another column from your input file...":
 * a small form for its header (exactly as in the file) and what it holds. The next conversion reads the column by that header.
 */
export function SourceField({ ctx, label, value, options, onChange, valuePrefix = '', hideLabel, className }: SourceFieldProps) {
  const { t } = useI18n();
  const [typing, setTyping] = useState(false);
  const choices = ctx.canTypeInput ? [...options, { value: OTHER, label: t('editor.source.other') }] : options;
  return (
    <>
      <SelectField
        {...(className ? { className } : {})}
        {...(hideLabel ? { hideLabel } : {})}
        label={label}
        value={typing ? OTHER : value}
        options={choices}
        onChange={(v) => {
          if (v === OTHER) setTyping(true);
          else {
            setTyping(false);
            onChange(v);
          }
        }}
      />
      {typing && (
        <TypedSource
          ctx={ctx}
          onUse={(id, typed) => {
            setTyping(false);
            onChange(valuePrefix + id, typed);
          }}
          onCancel={() => setTyping(false)}
        />
      )}
    </>
  );
}

function TypedSource({ ctx, onUse, onCancel }: { ctx: EditorCtx; onUse(id: string, typed: ExampleInputColumn): void; onCancel(): void }) {
  const { t } = useI18n();
  const [header, setHeader] = useState('');
  const [type, setType] = useState<ColumnType>('text');
  const name = header.trim();
  const use = (): void => {
    if (name === '') return;
    const typed: ExampleInputColumn = { header: name, type };
    onUse(ctx.addInput(typed), typed);
  };
  return (
    <div className="editor-form__group" data-testid="typed-source">
      <TextField label={t('editor.source.header')} hint={t('editor.source.headerHint')} value={header} onChange={setHeader} />
      <SelectField
        label={t('editor.source.type')}
        value={type}
        options={TYPED_TYPES.map((c): Option<ColumnType> => ({ value: c, label: t(`editor.type.${c}` as MessageKey) }))}
        onChange={(v) => setType(v)}
      />
      <div className="row">
        <Button variant="secondary" size="sm" disabled={name === ''} onClick={use}>
          {t('editor.source.use')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('editor.source.cancel')}
        </Button>
      </div>
    </div>
  );
}
