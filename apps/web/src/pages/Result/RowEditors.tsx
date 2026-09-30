// Row editors (SPEC 8.11): filters written as sentences, duplicates, and one-row-becomes-several.
import { COLUMN_TYPES, type ColumnType, type FilterScalar, type RowFilterOp } from '@formatai/shared';
import { printFormula } from '@formatai/engine/formula';
import { useState } from 'react';
import { sourceOptions, type ExpandInput, type FilterInput } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, InlineMessage, Switch } from '../../ui';
import { CheckField, ChoiceGroup, FormSection, ProblemList, SelectField, useEdit, type EditorCtx, type Option } from './fields';

// ---------- filters ----------

const OPS: readonly RowFilterOp[] = ['eq', 'ne', 'oneOf', 'notOneOf', 'isEmpty', 'notEmpty', 'gt', 'gte', 'lt', 'lte'];
const isList = (op: RowFilterOp): boolean => op === 'oneOf' || op === 'notOneOf';
const isUnary = (op: RowFilterOp): boolean => op === 'isEmpty' || op === 'notEmpty';

const show = (v: FilterScalar | undefined): string => (v === null || v === undefined ? '' : String(v));

export function FilterEditor({ ctx, index, onRemoved }: { ctx: EditorCtx; index: number; onRemoved(): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const filter = rules.input.rowFilters?.[index];
  const read = (): { column: string; op: RowFilterOp; text: string; list: string } => {
    const f = rules.input.rowFilters?.[index];
    if (!f || 'expr' in f) return { column: '', op: 'eq', text: '', list: '' };
    const value = 'value' in f ? f.value : undefined;
    return {
      column: f.column,
      op: f.op,
      text: Array.isArray(value) ? '' : show(value),
      list: Array.isArray(value) ? value.map(show).join('\n') : '',
    };
  };
  const [draft, setDraft] = useState(read);
  const edit = useEdit(ctx, () => setDraft(read()));
  if (!filter) return null;

  if ('expr' in filter) {
    return (
      <div className="editor-form">
        <InlineMessage tone="info">{t('editor.filter.formula')}</InlineMessage>
        <p className="formula-text" dir="ltr">
          {printFormula(filter.expr)}
        </p>
        <RemoveButton label={t('editor.filter.remove')} onClick={() => edit.run({ type: 'removeFilter', index }) && onRemoved()} />
        <ProblemList problems={edit.problems} />
      </div>
    );
  }

  const columns = sourceOptions(rules).map((s): Option => ({ value: s.id, label: s.label }));
  const change = (next: typeof draft, coalesce?: string): void => {
    setDraft(next);
    const list = next.list
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => v !== '');
    let input: FilterInput;
    if (isUnary(next.op)) input = { column: next.column, op: next.op };
    else if (isList(next.op)) {
      if (list.length === 0) return; // nothing to compare with yet: the field stays as typed
      input = { column: next.column, op: next.op, value: list };
    } else input = { column: next.column, op: next.op, value: next.text };
    edit.run({ type: 'updateFilter', index, filter: input }, coalesce ? { coalesce } : undefined);
  };

  return (
    <div className="editor-form">
      <p className="editor-form__lead">{t('editor.filter.keep')}</p>
      <SelectField label={t('editor.filter.column')} value={draft.column} options={columns} onChange={(column) => change({ ...draft, column })} />
      <SelectField
        label={t('editor.filter.op')}
        value={draft.op}
        options={OPS.map((op): Option<RowFilterOp> => ({ value: op, label: t(`editor.filter.op.${op}` as MessageKey) }))}
        onChange={(op) => {
          // Keep what was typed when the new operator can use it.
          const list = draft.list !== '' ? draft.list : draft.text;
          change({ ...draft, op, list, text: draft.text !== '' ? draft.text : draft.list.split(/\r?\n/)[0] ?? '' });
        }}
      />
      {!isUnary(draft.op) && !isList(draft.op) && (
        <div className="field">
          <label className="field__label" htmlFor={`filter-value-${index}`}>
            {t('editor.filter.value')}
          </label>
          <input id={`filter-value-${index}`} className="input" dir="auto" value={draft.text} onChange={(e) => change({ ...draft, text: e.target.value }, `filter:${index}`)} autoComplete="off" />
        </div>
      )}
      {isList(draft.op) && (
        <div className="field">
          <label className="field__label" htmlFor={`filter-list-${index}`}>
            {t('editor.filter.list')}
          </label>
          <textarea id={`filter-list-${index}`} className="input input--area" dir="auto" rows={4} value={draft.list} onChange={(e) => change({ ...draft, list: e.target.value }, `filter:${index}`)} />
          <p className="field__hint">{t('editor.filter.listHint')}</p>
        </div>
      )}
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.filter.remove')} onClick={() => edit.run({ type: 'removeFilter', index }) && onRemoved()} />
    </div>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <div className="editor-form__footer">
      <Button variant="ghost" size="sm" icon="trash" onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}

// ---------- duplicates ----------

export function DedupeEditor({ ctx }: { ctx: EditorCtx }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const dedupe = rules.transform.dedupe;
  const edit = useEdit(ctx);
  const inputs = sourceOptions(rules).filter((s) => s.kind === 'input');
  const keys = dedupe && dedupe.keys !== 'all' ? dedupe.keys : [];

  return (
    <div className="editor-form">
      <Switch
        checked={dedupe !== undefined}
        label={t('editor.dedupe.on')}
        onChange={(on) => edit.run(on ? { type: 'setDedupe', enabled: true, keys: 'all', keep: 'first', action: 'flag' } : { type: 'setDedupe', enabled: false })}
      />
      {dedupe && (
        <>
          <ChoiceGroup
            label={t('editor.dedupe.same')}
            value={dedupe.keys === 'all' ? 'all' : 'some'}
            options={[
              { value: 'all', label: t('editor.dedupe.same.all') },
              { value: 'some', label: t('editor.dedupe.same.some') },
            ]}
            onChange={(v) => edit.run({ type: 'setDedupe', enabled: true, keys: v === 'all' ? 'all' : [inputs[0]?.id ?? ''] })}
          />
          {dedupe.keys !== 'all' && (
            <FormSection>
              {inputs.map((s) => (
                <CheckField
                  key={s.id}
                  label={<bdi>{s.label}</bdi>}
                  checked={keys.includes(s.id)}
                  onChange={(on) => {
                    const next = on ? [...keys, s.id] : keys.filter((k) => k !== s.id);
                    if (next.length > 0) edit.run({ type: 'setDedupe', enabled: true, keys: next });
                  }}
                />
              ))}
            </FormSection>
          )}
          <ChoiceGroup
            label={t('editor.dedupe.keep')}
            value={dedupe.keep}
            options={[
              { value: 'first', label: t('editor.dedupe.keep.first') },
              { value: 'last', label: t('editor.dedupe.keep.last') },
            ]}
            onChange={(keep) => edit.run({ type: 'setDedupe', enabled: true, keep })}
          />
          <ChoiceGroup
            label={t('editor.dedupe.action')}
            value={dedupe.action}
            options={[
              { value: 'flag', label: t('editor.dedupe.action.flag') },
              { value: 'remove', label: t('editor.dedupe.action.remove') },
            ]}
            onChange={(action) => edit.run({ type: 'setDedupe', enabled: true, action })}
          />
          <p className="field__hint">{t(dedupe.action === 'flag' ? 'editor.dedupe.flagHint' : 'editor.dedupe.removeHint')}</p>
        </>
      )}
      <ProblemList problems={edit.problems} />
    </div>
  );
}

// ---------- one row becomes several ----------

export function ExpandEditor({ ctx, onRemoved }: { ctx: EditorCtx; onRemoved(): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const expand = rules.transform.expand;
  const edit = useEdit(ctx);
  if (!expand) return null;
  const set = (next: ExpandInput, coalesce?: string): void => void edit.run({ type: 'setExpand', expand: next }, coalesce ? { coalesce } : undefined);

  return (
    <div className="editor-form">
      {expand.mode === 'columnsToRows' && (
        <>
          <p className="editor-form__lead">{t('editor.expand.columnsToRows')}</p>
          <FormSection title={t('editor.expand.columns')}>
            {rules.input.columns.map((c) => (
              <CheckField
                key={c.id}
                label={<bdi>{c.header}</bdi>}
                checked={expand.columns.includes(c.id)}
                onChange={(on) => {
                  const columns = on ? [...expand.columns, c.id] : expand.columns.filter((x) => x !== c.id);
                  if (columns.length > 0) set({ ...expand, columns });
                }}
              />
            ))}
          </FormSection>
          <SelectField
            label={t('editor.expand.valueType')}
            value={expand.valueType}
            options={COLUMN_TYPES.map((c): Option<ColumnType> => ({ value: c, label: t(`editor.type.${c}` as MessageKey) }))}
            onChange={(valueType) => set({ ...expand, valueType })}
          />
          <CheckField label={t('editor.expand.skipEmpty')} checked={expand.skipEmpty} onChange={(skipEmpty) => set({ ...expand, skipEmpty })} />
        </>
      )}
      {expand.mode === 'splitCell' && (
        <>
          <p className="editor-form__lead">{t('editor.expand.splitCell')}</p>
          <SelectField
            label={t('editor.expand.splitColumn')}
            value={expand.column}
            options={rules.input.columns.map((c): Option => ({ value: c.id, label: c.header }))}
            onChange={(column) => set({ ...expand, column })}
          />
          <div className="field">
            <label className="field__label" htmlFor="expand-separator">
              {t('editor.expand.separator')}
            </label>
            <input id="expand-separator" className="input" dir="auto" value={expand.separator} onChange={(e) => e.target.value !== '' && set({ ...expand, separator: e.target.value }, 'separator')} autoComplete="off" />
          </div>
          <CheckField label={t('editor.expand.trim')} checked={expand.trim} onChange={(trim) => set({ ...expand, trim })} />
          <CheckField label={t('editor.expand.skipEmptyParts')} checked={expand.skipEmpty} onChange={(skipEmpty) => set({ ...expand, skipEmpty })} />
        </>
      )}
      {expand.mode === 'fixedFanOut' && <InlineMessage tone="info">{t('editor.expand.fanOut', { n: expand.rows.length })}</InlineMessage>}
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.expand.remove')} onClick={() => edit.run({ type: 'setExpand', expand: null }) && onRemoved()} />
    </div>
  );
}
