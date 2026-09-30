// The editor for one check (SPEC 8.8, 8.11 "Checks"): where it looks, which rule, and what happens to a row that fails.
import type { Validation } from '@formatai/shared';
import { useState } from 'react';
import { sourceOptions } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { ChoiceGroup, NumberField, ProblemList, SelectField, useEdit, type EditorCtx, type Option } from './fields';
import { RemoveButton } from './RowEditors';

type Rule = Validation['rule'];
const RULES: readonly Rule[] = ['required', 'range', 'lengthEquals', 'oneOf', 'unique', 'dateRange', 'israeliIdChecksum'];

function starter(rule: Rule, base: { on?: 'input' | 'output'; column: string; severity: 'flag' | 'block' }): Validation {
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

  const on = v.on ?? 'input';
  const columns: Option[] =
    on === 'output' ? rules.output.columns.map((c) => ({ value: c.header, label: c.header })) : sourceOptions(rules).map((s) => ({ value: s.id, label: s.label }));
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
          const first = next === 'output' ? rules.output.columns[0]?.header : sourceOptions(rules)[0]?.id;
          if (first !== undefined) set({ ...v, on: next, column: first } as Validation);
        }}
      />
      <SelectField label={t('editor.check.column')} value={v.column} options={columns} onChange={(column) => set({ ...v, column } as Validation)} />
      <SelectField
        label={t('editor.check.rule')}
        value={v.rule}
        options={RULES.map((r): Option<Rule> => ({ value: r, label: t(`editor.check.rule.${r}` as MessageKey) }))}
        onChange={(rule) => {
          if (rule !== v.rule) set(starter(rule, base));
        }}
      />
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

