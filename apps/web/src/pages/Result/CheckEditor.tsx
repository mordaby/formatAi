// The editor for one check (SPEC 8.8, 8.11 "Checks"): where it looks, which rule, and what happens to a row that fails.
import { printFormula } from '@formatai/engine/formula';
import type { Validation } from '@formatai/shared';
import { useState } from 'react';
import { sourceOptions } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { ChoiceGroup, NumberField, ProblemList, SelectField, SourceField, useEdit, type EditorCtx, type Option } from './fields';
import { RemoveButton } from './RowEditors';

type Rule = Validation['rule'];
/** The rules a user can start a check with. A cut-off check (`cutoffRange`) and an open question's marker (`sameAs`, SPEC 8.8) are only ever written by code. */
type StarterRule = Exclude<Rule, 'cutoffRange' | 'sameAs'>;
const RULES: readonly StarterRule[] = ['required', 'range', 'lengthEquals', 'oneOf', 'unique', 'dateRange', 'israeliIdChecksum'];

function starter(rule: StarterRule, base: { on?: 'input' | 'output'; column: string; severity: 'flag' | 'block' }): Validation {
  const year = new Date().getFullYear();
  switch (rule) {
    case 'range':
      return { ...base, rule, min: 0 };
    case 'lengthEquals':
      return { ...base, rule, length: 9 };
    case 'oneOf':
      return { ...base, rule, values: [] };
    case 'dateRange':
      return { ...base, rule, from: `${year}-01-01`, to: `${year}-12-31` };
    default:
      return { ...base, rule };
  }
}

export function CheckEditor({ ctx, index, onRemoved }: { ctx: EditorCtx; index: number; onRemoved(): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const v = rules.validations[index];
  const [list, setList] = useState(() => (v?.rule === 'oneOf' ? v.values.join('\n') : ''));
  const edit = useEdit(ctx, () => {
    const cur = rules.validations[index];
    setList(cur?.rule === 'oneOf' ? cur.values.join('\n') : '');
  });
  if (!v) return null;
  // The marker of an open question (SPEC 8.8 `sameAs`, 21 v12 item 17): it says the other rule and can only be deleted - answering the
  // question on the column's line is what changes the rule (DECISION: its expression is not edited here).
  if (v.rule === 'sameAs') {
    return (
      <div className="editor-form">
        <p className="field__hint">{t('editor.check.sameAs', { other: printFormula(v.expr) })}</p>
        <RemoveButton label={t('editor.check.remove')} onClick={() => edit.run({ type: 'removeValidation', index }) && onRemoved()} />
      </div>
    );
  }

  const on = v.on ?? 'input';
  const columns: Option[] =
    on === 'output' ? rules.output.columns.map((c) => ({ value: c.header, label: c.header })) : sourceOptions(rules, { exampleInput: ctx.available }).map((s) => ({ value: s.id, label: s.label }));
  const set = (next: Validation, coalesce?: string): void => void edit.run({ type: 'updateValidation', index, validation: next }, coalesce ? { coalesce } : undefined);
  const base = { on, column: v.column, severity: v.severity };

  return (
    <div className="editor-form">
      <ChoiceGroup
        label={t('editor.check.on')}
        value={on}
        options={[
          { value: 'input', label: t('editor.check.on.input') },
          { value: 'output', label: t('editor.check.on.output') },
        ]}
        onChange={(next) => {
          const first = next === 'output' ? rules.output.columns[0]?.header : sourceOptions(rules, { exampleInput: ctx.available })[0]?.id;
          if (first !== undefined) set({ ...v, on: next, column: first } as Validation);
        }}
      />
      {on === 'output' ? (
        <SelectField label={t('editor.check.column')} value={v.column} options={columns} onChange={(column) => set({ ...v, column } as Validation)} />
      ) : (
        <SourceField ctx={ctx} label={t('editor.check.column')} value={v.column} options={columns} onChange={(column) => set({ ...v, column } as Validation)} />
      )}
      <SelectField
        label={t('editor.check.rule')}
        value={v.rule}
        options={[...RULES, ...(v.rule === 'cutoffRange' ? (['cutoffRange'] as const) : [])].map((r): Option<Rule> => ({ value: r, label: t(`editor.check.rule.${r}` as MessageKey) }))}
        onChange={(rule) => {
          if (rule !== v.rule && rule !== 'cutoffRange' && rule !== 'sameAs') set(starter(rule, base));
        }}
      />
      {v.rule === 'cutoffRange' && <CutoffFields check={v} onChange={(next, field) => set(next, field)} />}
      {v.rule === 'range' && (
        <div className="row row--end">
          <NumberField
            className="row__grow"
            label={t('editor.check.min')}
            value={v.min}
            onChange={(min) => set({ on, column: v.column, rule: 'range', severity: v.severity, ...(min === undefined ? {} : { min }), ...(v.max === undefined ? {} : { max: v.max }) }, 'min')}
          />
          <NumberField
            className="row__grow"
            label={t('editor.check.max')}
            value={v.max}
            onChange={(max) => set({ on, column: v.column, rule: 'range', severity: v.severity, ...(v.min === undefined ? {} : { min: v.min }), ...(max === undefined ? {} : { max }) }, 'max')}
          />
        </div>
      )}
      {v.rule === 'lengthEquals' && <NumberField label={t('editor.check.length')} min={1} value={v.length} onChange={(length) => set({ ...v, length: length ?? 1 }, 'length')} />}
      {v.rule === 'oneOf' && (
        <div className="field">
          <label className="field__label" htmlFor={`check-values-${index}`}>
            {t('editor.check.values')}
          </label>
          <textarea
            id={`check-values-${index}`}
            className="input input--area"
            dir="auto"
            rows={4}
            value={list}
            onChange={(e) => {
              setList(e.target.value);
              const values = e.target.value
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter((x) => x !== '');
              if (values.length > 0) set({ ...v, values }, 'values');
            }}
          />
          <p className="field__hint">{t('editor.filter.listHint')}</p>
        </div>
      )}
      {v.rule === 'dateRange' && (
        <div className="row row--end">
          <DateField label={t('editor.check.from')} value={v.from} onChange={(from) => set({ ...v, from })} />
          <DateField label={t('editor.check.to')} value={v.to} onChange={(to) => set({ ...v, to })} />
        </div>
      )}
      <ChoiceGroup
        label={t('editor.check.severity')}
        value={v.severity}
        options={[
          { value: 'flag', label: t('editor.check.severity.flag') },
          { value: 'block', label: t('editor.check.severity.block') },
        ]}
        onChange={(severity) => set({ ...v, severity } as Validation)}
      />
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.check.remove')} onClick={() => edit.run({ type: 'removeValidation', index }) && onRemoved()} />
    </div>
  );
}

/**
 * A cut-off the example did not settle (SPEC 8.8): the sentence that says what code found, and the two edges, editable (numbers, or dates
 * on a date column). A value strictly between them is flagged at run time. The value the rule uses is said, not edited here: it is the
 * rule's own constant (the formula of its column).
 */
function CutoffFields({ check, onChange }: { check: Extract<Validation, { rule: 'cutoffRange' }>; onChange(next: Validation, field: string): void }) {
  const { t } = useI18n();
  const shown = (x: number | string): string => (typeof x === 'string' ? x.split('-').reverse().join('/') : String(x));
  const dates = typeof check.low === 'string';
  return (
    <>
      <p className="field__hint">
        {t(check.includes === 'high' ? 'editor.check.cutoff.high' : 'editor.check.cutoff.low', { low: shown(check.low), high: shown(check.high), value: shown(check.value) })}
      </p>
      <div className="row row--end">
        {dates ? (
          <>
            <DateField label={t('editor.check.cutoff.lowEdge')} value={String(check.low)} onChange={(low) => onChange({ ...check, low }, 'low')} />
            <DateField label={t('editor.check.cutoff.highEdge')} value={String(check.high)} onChange={(high) => onChange({ ...check, high }, 'high')} />
          </>
        ) : (
          <>
            <NumberField className="row__grow" label={t('editor.check.cutoff.lowEdge')} value={check.low as number} onChange={(low) => low !== undefined && onChange({ ...check, low }, 'low')} />
            <NumberField className="row__grow" label={t('editor.check.cutoff.highEdge')} value={check.high as number} onChange={(high) => high !== undefined && onChange({ ...check, high }, 'high')} />
          </>
        )}
      </div>
    </>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <div className="field row__grow">
      <label className="field__label">
        {label}
        <input className="input" type="date" dir="ltr" value={value} onChange={(e) => e.target.value !== '' && onChange(e.target.value)} />
      </label>
    </div>
  );
}

