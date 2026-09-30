// The column editor (SPEC 8.11): a name, "How is it made?" with seven ways, and the output format with a live preview.
import { COLUMN_TYPES, type ColumnType, type PayloadCell } from '@formatai/shared';
import { Fragment, useState } from 'react';
import {
  editorConfig,
  readColumnMethod,
  sourceOptions,
  type CalcOp,
  type CalcTerm,
  type ColumnMethod,
  type SourceOption,
  type TranslatePair,
} from '../../editor';
import { outputColumnType } from '../../editor/rulesUtil';
import { useI18n, type MessageKey } from '../../i18n';
import type { Line } from '../../rulesText';
import { Button, InlineMessage } from '../../ui';
import type { LiveCheckResult } from '../../worker/editorApi';
import { CheckField, ChoiceGroup, FormSection, NumberField, ProblemList, SelectField, SourceField, TextField, useEdit, type EditorCtx, type Option } from './fields';
import { exampleValues } from './helpers';
import { formatPreview } from './formatPreview';

type Kind = ColumnMethod['kind'];

const KINDS: readonly Kind[] = ['copy', 'calculate', 'join', 'partOfText', 'translate', 'fixed', 'empty'];
const KIND_LABEL: Record<Kind, MessageKey> = {
  copy: 'editor.col.kind.copy',
  calculate: 'editor.col.kind.calculate',
  join: 'editor.col.kind.join',
  partOfText: 'editor.col.kind.partOfText',
  translate: 'editor.col.kind.translate',
  fixed: 'editor.col.kind.fixed',
  empty: 'editor.col.kind.empty',
  formula: 'editor.col.kind.formula',
};

const isTextLike = (t: SourceOption['type']): boolean => t === 'text' || t === 'idLike';
const isNumeric = (t: SourceOption['type']): boolean => t === 'integer' || t === 'decimal';

/** A sensible first version of a method the user has just chosen (carrying over the column they were already using). */
function starter(kind: Kind, sources: readonly SourceOption[], current: ColumnMethod | undefined): ColumnMethod {
  const currentSource =
    current && 'source' in current ? current.source : current?.kind === 'join' ? current.columns[0] : current?.kind === 'calculate' && 'column' in current.terms[0]! ? current.terms[0].column : undefined;
  const pick = (pred: (s: SourceOption) => boolean): string => sources.find((s) => s.id === currentSource && pred(s))?.id ?? sources.find(pred)?.id ?? sources[0]?.id ?? '';
  switch (kind) {
    case 'copy':
      return { kind, source: pick(() => true) };
    case 'calculate': {
      const id = pick((s) => isNumeric(s.type));
      // A text column is read as a number, which is what the checker asks for.
      return { kind, terms: [isTextLike(sources.find((s) => s.id === id)?.type) ? { column: id, toNumber: true } : { column: id }], ops: [] };
    }
    case 'join': {
      const first = pick((s) => isTextLike(s.type));
      const second = sources.find((s) => s.id !== first && isTextLike(s.type))?.id ?? sources.find((s) => s.id !== first)?.id ?? first;
      return { kind, columns: [first, second], separator: ' ' };
    }
    case 'partOfText':
      return { kind, source: pick((s) => isTextLike(s.type)), part: 'first', n: 3 };
    case 'translate':
      return { kind, source: pick((s) => isTextLike(s.type)), pairs: [], onMissing: 'keep' };
    case 'fixed':
      return { kind, value: '' };
    case 'empty':
      return { kind };
    case 'formula':
      return { kind, formula: '' };
  }
}

export interface ColumnEditorProps {
  ctx: EditorCtx;
  index: number;
  line: Line | undefined;
  live: LiveCheckResult | null | undefined;
  onRenamed(header: string): void;
  onRemoved(): void;
  onMove(delta: number): void;
}

export function ColumnEditor({ ctx, index, line, live, onRenamed, onRemoved, onMove }: ColumnEditorProps) {
  const { t } = useI18n();
  const { rules } = ctx;
  const col = rules.output.columns[index];
  const [header, setHeader] = useState(col?.header ?? '');
  const [draft, setDraft] = useState<ColumnMethod | undefined>(() => readColumnMethod(rules, index));
  const edit = useEdit(ctx, () => {
    setHeader(rules.output.columns[index]?.header ?? '');
    setDraft(readColumnMethod(rules, index));
  });
  if (!col || !draft) return null;

  const sources = sourceOptions(rules, { forColumn: index, exampleInput: ctx.available });
  const examples = exampleValues(live, index);
  const wants = line && (line.status === 'needsInput' || line.status === 'check') && line.statusReason;

  const setMethod = (next: ColumnMethod, coalesce?: string): void => {
    setDraft(next);
    // A translate row the user has just added has no value yet: it stays on screen but is not part of the rules.
    const method = next.kind === 'translate' ? { ...next, pairs: next.pairs.filter((p) => p.from !== '') } : next;
    edit.run({ type: 'setColumnMethod', index, method }, coalesce ? { coalesce } : undefined);
  };

  return (
    <div className="editor-form">
      {wants ? (
        <InlineMessage tone="warn" title={line.status === 'needsInput' ? t('map.status.needsInput') : t('map.status.check')}>
          {line.statusReason}
        </InlineMessage>
      ) : null}

      {examples.length > 0 && (line?.status === 'needsInput' || draft.kind === 'empty') && (
        <div className="example-values">
          <p className="field__label">{t('editor.col.exampleShows')}</p>
          <ul className="chips chips--plain">
            {examples.map((v, i) => (
              <li key={i}>
                <bdi>{String(v)}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TextField
        label={t('editor.col.header')}
        value={header}
        onChange={(v) => {
          setHeader(v);
          if (edit.run({ type: 'setColumnHeader', index, header: v }, { coalesce: `header:${index}` })) onRenamed(v);
        }}
      />

      <ChoiceGroup
        variant="chips"
        label={t('editor.col.how')}
        value={draft.kind}
        options={(draft.kind === 'formula' ? [...KINDS, 'formula' as const] : KINDS).map((k): Option<Kind> => ({ value: k, label: t(KIND_LABEL[k]) }))}
        onChange={(kind) => {
          if (kind !== draft.kind) setMethod(starter(kind, sources, draft));
        }}
      />

      <MethodForm ctx={ctx} draft={draft} sources={sources} setMethod={setMethod} />

      <ProblemList problems={edit.problems} />

      <FormatSection ctx={ctx} index={index} live={live} examples={examples} />

      <div className="editor-form__footer">
        <div className="editor-form__moves">
          <Button variant="ghost" size="sm" icon="chevronUp" onClick={() => onMove(-1)} disabled={index === 0} aria-label={t('editor.col.moveUp')} />
          <Button variant="ghost" size="sm" icon="chevronDown" onClick={() => onMove(1)} disabled={index === rules.output.columns.length - 1} aria-label={t('editor.col.moveDown')} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="trash"
          onClick={() => {
            if (edit.run({ type: 'removeColumn', index })) onRemoved();
          }}
        >
          {t('editor.col.remove')}
        </Button>
      </div>
    </div>
  );
}

// ---------- the seven forms ----------

interface MethodFormProps {
  ctx: EditorCtx;
  draft: ColumnMethod;
  sources: readonly SourceOption[];
  setMethod(next: ColumnMethod, coalesce?: string): void;
}

function sourceChoices(sources: readonly SourceOption[]): Option[] {
  return sources.map((s) => ({ value: s.id, label: s.label }));
}

function MethodForm({ ctx, draft, sources, setMethod }: MethodFormProps) {
  const { t } = useI18n();
  switch (draft.kind) {
    case 'copy':
      return (
        <FormSection>
          <SourceField ctx={ctx} label={t('editor.col.source')} value={draft.source} options={sourceChoices(sources)} onChange={(source) => setMethod({ ...draft, source })} />
          <NumberField
            label={t('editor.col.pad')}
            hint={t('editor.col.padHint')}
            min={1}
            max={99}
            value={draft.padLeft}
            onChange={(padLeft) => setMethod({ kind: 'copy', source: draft.source, ...(padLeft === undefined ? {} : { padLeft }), ...(draft.trim ? { trim: true } : {}) }, 'pad')}
          />
          <CheckField
            label={t('editor.col.trim')}
            checked={draft.trim === true}
            onChange={(trim) => setMethod({ kind: 'copy', source: draft.source, ...(draft.padLeft === undefined ? {} : { padLeft: draft.padLeft }), ...(trim ? { trim: true } : {}) })}
          />
        </FormSection>
      );
    case 'calculate':
      return <CalculateForm ctx={ctx} draft={draft} sources={sources} setMethod={setMethod} />;
    case 'join':
      return (
        <FormSection>
          <p className="field__label">{t('editor.col.joinColumns')}</p>
          {draft.columns.map((c, i) => (
            <div className="row" key={i}>
              <SourceField
                ctx={ctx}
                className="row__grow"
                hideLabel
                label={t('editor.col.joinColumn', { n: i + 1 })}
                value={c}
                options={sourceChoices(sources)}
                onChange={(next) => setMethod({ ...draft, columns: draft.columns.map((x, k) => (k === i ? next : x)) })}
              />
              {draft.columns.length > 2 && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="close"
                  aria-label={t('editor.col.removeColumnN', { n: i + 1 })}
                  onClick={() => setMethod({ ...draft, columns: draft.columns.filter((_, k) => k !== i) })}
                />
              )}
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon="plus"
              onClick={() => setMethod({ ...draft, columns: [...draft.columns, sources.find((s) => !draft.columns.includes(s.id))?.id ?? draft.columns[0] ?? ''] })}
            >
              {t('editor.col.addJoinColumn')}
            </Button>
          </div>
          <TextField label={t('editor.col.separator')} hint={t('editor.col.separatorHint')} value={draft.separator} onChange={(separator) => setMethod({ ...draft, separator }, 'separator')} />
          <TextField label={t('editor.col.joinBefore')} hint={t('editor.col.joinFixedHint')} value={draft.before ?? ''} onChange={(before) => setMethod(withFixed(draft, 'before', before), 'joinBefore')} />
          <TextField label={t('editor.col.joinAfter')} value={draft.after ?? ''} onChange={(after) => setMethod(withFixed(draft, 'after', after), 'joinAfter')} />
        </FormSection>
      );
    case 'partOfText':
      return (
        <FormSection>
          <SourceField ctx={ctx} label={t('editor.col.source')} value={draft.source} options={sourceChoices(sources)} onChange={(source) => setMethod({ ...draft, source })} />
          <ChoiceGroup
            label={t('editor.col.part')}
            value={draft.part}
            options={[
              { value: 'first', label: t('editor.col.part.first') },
              { value: 'last', label: t('editor.col.part.last') },
            ]}
            onChange={(part) => setMethod({ ...draft, part })}
          />
          <NumberField label={t('editor.col.partN')} min={1} value={draft.n} onChange={(n) => setMethod({ ...draft, n: n ?? 1 }, 'partN')} />
        </FormSection>
      );
    case 'translate':
      return <TranslateForm ctx={ctx} draft={draft} sources={sources} setMethod={setMethod} />;
    case 'fixed':
      return <FixedForm draft={draft} setMethod={setMethod} />;
    case 'empty':
      return <p className="muted">{t('editor.col.emptyNote')}</p>;
    case 'formula':
      return (
        <FormSection>
          <TextField mono dir="ltr" label={t('editor.col.formula')} hint={t('editor.col.formulaHint')} value={draft.formula} onChange={(formula) => setMethod({ ...draft, formula }, 'formula')} />
          <SelectField
            label={t('editor.col.formulaType')}
            value={draft.type ?? 'text'}
            options={COLUMN_TYPES.map((c): Option<ColumnType> => ({ value: c, label: t(`editor.type.${c}` as MessageKey) }))}
            onChange={(type) => setMethod({ ...draft, type })}
          />
        </FormSection>
      );
  }
}

/** The join with its fixed text at the start or the end set (an empty text removes it). */
function withFixed(draft: Extract<ColumnMethod, { kind: 'join' }>, side: 'before' | 'after', text: string): ColumnMethod {
  const { before, after, ...rest } = draft;
  const fixed = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
  delete fixed[side];
  return { ...rest, ...fixed, ...(text === '' ? {} : { [side]: text }) };
}

// ---------- Calculate: blocks, not typed ----------

const OPS: readonly { value: CalcOp; label: string }[] = [
  { value: '+', label: '+' },
  { value: '-', label: '−' },
  { value: '*', label: '×' },
  { value: '/', label: '÷' },
];

function CalculateForm({ ctx, draft, sources, setMethod }: MethodFormProps & { draft: Extract<ColumnMethod, { kind: 'calculate' }> }) {
  const { t } = useI18n();
  const usable = sources.filter((s) => isNumeric(s.type) || isTextLike(s.type));
  const setTerm = (i: number, term: CalcTerm): void => setMethod({ ...draft, terms: draft.terms.map((x, k) => (k === i ? term : x)) }, `term:${i}`);
  return (
    <FormSection>
      <p className="field__label">{t('editor.col.calc')}</p>
      <div className="calc" role="group" aria-label={t('editor.col.calc')}>
        {draft.terms.map((term, i) => {
          const value = 'number' in term ? '#number' : `col:${term.column}`;
          return (
            <Fragment key={i}>
              {i > 0 && (
                <SelectField
                  className="calc__op"
                  hideLabel
                  label={t('editor.col.calcOp', { n: i })}
                  value={draft.ops[i - 1] ?? '+'}
                  options={OPS}
                  onChange={(op) => setMethod({ ...draft, ops: draft.ops.map((x, k) => (k === i - 1 ? op : x)) })}
                />
              )}
              <div className="calc__block">
                <SourceField
                  ctx={ctx}
                  valuePrefix="col:"
                  hideLabel
                  label={t('editor.col.calcTerm', { n: i + 1 })}
                  value={value}
                  options={[
                    ...usable.map((s): Option => ({ value: `col:${s.id}`, label: isTextLike(s.type) ? `${s.label} (${t('editor.col.textAsNumber')})` : s.label })),
                    { value: '#number', label: t('editor.col.aNumber') },
                  ]}
                  onChange={(v, typed) => {
                    if (v === '#number') setTerm(i, { number: 1 });
                    else {
                      const id = v.slice(4);
                      const src = usable.find((s) => s.id === id);
                      // A column just typed in is not in the list yet: what the person said it holds decides.
                      const text = src ? isTextLike(src.type) : typed !== undefined && (typed.type === 'text' || typed.type === 'idLike');
                      setTerm(i, text ? { column: id, toNumber: true } : { column: id });
                    }
                  }}
                />
                {'number' in term && (
                  <NumberField hideLabel label={t('editor.col.calcNumber', { n: i + 1 })} value={term.number} onChange={(n) => setTerm(i, { number: n ?? 0 })} />
                )}
                {draft.terms.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="close"
                    aria-label={t('editor.col.calcRemove', { n: i + 1 })}
                    onClick={() => setMethod({ ...draft, terms: draft.terms.filter((_, k) => k !== i), ops: draft.ops.filter((_, k) => k !== Math.max(0, i - 1)) })}
                  />
                )}
              </div>
            </Fragment>
          );
        })}
        {draft.terms.length < editorConfig.maxCalcTerms && (
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setMethod({ ...draft, terms: [...draft.terms, { number: 1 }], ops: [...draft.ops, '*'] })}>
            {t('editor.col.calcAdd')}
          </Button>
        )}
      </div>
      <div className="row row--end">
        <CheckField
          label={t('editor.col.round')}
          checked={draft.round !== undefined}
          onChange={(on) => {
            const { round: _round, ...rest } = draft;
            void _round;
            setMethod(on ? { ...rest, round: 2 } : rest);
          }}
        />
        {draft.round !== undefined && (
          <NumberField label={t('editor.col.roundDigits')} min={0} max={15} value={draft.round} onChange={(round) => setMethod({ ...draft, round: round ?? 0 }, 'round')} />
        )}
      </div>
    </FormSection>
  );
}

// ---------- Translate values ----------

function TranslateForm({ ctx, draft, sources, setMethod }: MethodFormProps & { draft: Extract<ColumnMethod, { kind: 'translate' }> }) {
  const { t } = useI18n();
  const setPair = (i: number, patch: Partial<TranslatePair>): void => setMethod({ ...draft, pairs: draft.pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)) }, `pair:${i}`);
  return (
    <FormSection>
      <SourceField ctx={ctx} label={t('editor.col.source')} value={draft.source} options={sourceChoices(sources)} onChange={(source) => setMethod({ ...draft, source })} />
      <table className="pairs">
        <thead>
          <tr>
            <th scope="col">{t('editor.col.translateFrom')}</th>
            <th scope="col">{t('editor.col.translateTo')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('editor.col.translateRemove')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.pairs.map((p, i) => (
            <tr key={i}>
              <td>
                <input className="input" dir="auto" aria-label={t('editor.col.translateFromN', { n: i + 1 })} value={p.from} onChange={(e) => setPair(i, { from: e.target.value })} />
              </td>
              <td>
                <input className="input" dir="auto" aria-label={t('editor.col.translateToN', { n: i + 1 })} value={p.to} onChange={(e) => setPair(i, { to: e.target.value })} />
              </td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="close"
                  aria-label={t('editor.col.translateRemoveN', { n: i + 1 })}
                  onClick={() => setMethod({ ...draft, pairs: draft.pairs.filter((_, k) => k !== i) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <Button variant="ghost" size="sm" icon="plus" onClick={() => setMethod({ ...draft, pairs: [...draft.pairs, { from: '', to: '' }] })}>
          {t('editor.col.translateAdd')}
        </Button>
      </div>
      <ChoiceGroup
        label={t('editor.col.translateMissing')}
        value={draft.onMissing}
        options={[
          { value: 'flag', label: t('editor.col.translateMissing.flag') },
          { value: 'keep', label: t('editor.col.translateMissing.keep') },
        ]}
        onChange={(onMissing) => setMethod({ ...draft, onMissing })}
      />
    </FormSection>
  );
}

// ---------- Fixed value ----------

type FixedKind = 'text' | 'number' | 'boolean';
const fixedKindOf = (v: string | number | boolean): FixedKind => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text');

function FixedForm({ draft, setMethod }: { draft: Extract<ColumnMethod, { kind: 'fixed' }>; setMethod(next: ColumnMethod, coalesce?: string): void }) {
  const { t } = useI18n();
  const kind = fixedKindOf(draft.value);
  return (
    <FormSection>
      <ChoiceGroup
        label={t('editor.col.fixedKind')}
        value={kind}
        options={[
          { value: 'text', label: t('editor.col.fixed.text') },
          { value: 'number', label: t('editor.col.fixed.number') },
          { value: 'boolean', label: t('editor.col.fixed.boolean') },
        ]}
        onChange={(k) => setMethod({ kind: 'fixed', value: k === 'text' ? '' : k === 'number' ? 0 : true })}
      />
      {kind === 'text' && <TextField label={t('editor.col.fixedValue')} value={String(draft.value)} onChange={(value) => setMethod({ kind: 'fixed', value }, 'fixed')} />}
      {kind === 'number' && <NumberField label={t('editor.col.fixedValue')} value={draft.value as number} onChange={(value) => setMethod({ kind: 'fixed', value: value ?? 0 }, 'fixed')} />}
      {kind === 'boolean' && (
        <ChoiceGroup
          label={t('editor.col.fixedValue')}
          value={draft.value === true ? 'yes' : 'no'}
          options={[
            { value: 'yes', label: t('editor.col.fixed.yes') },
            { value: 'no', label: t('editor.col.fixed.no') },
          ]}
          onChange={(v) => setMethod({ kind: 'fixed', value: v === 'yes' })}
        />
      )}
    </FormSection>
  );
}

// ---------- the output format, with a preview ----------

const NUMBER_PRESETS = ['#,##0.00', '#,##0', '0.00', '0', '0.00%'] as const;
const DATE_PRESETS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D MMMM YYYY', 'MMMM YYYY'] as const;
const CUSTOM = '#custom';
const AS_IS = '#asis';

function FormatSection({ ctx, index, live, examples }: { ctx: EditorCtx; index: number; live: LiveCheckResult | null | undefined; examples: PayloadCell[] }) {
  const { t } = useI18n();
  const col = ctx.rules.output.columns[index]!;
  const type = outputColumnType(ctx.rules, col);
  const [custom, setCustom] = useState<string | undefined>(undefined);
  const edit = useEdit(ctx, () => setCustom(undefined));
  const presets: readonly string[] = type === 'date' ? DATE_PRESETS : type === 'integer' || type === 'decimal' ? NUMBER_PRESETS : [];
  const current = col.format;
  const isPreset = current !== undefined && presets.includes(current);
  const mode = custom !== undefined ? CUSTOM : current === undefined ? AS_IS : isPreset ? current : CUSTOM;
  // A value to show it on: what the rules produce for the first row that has one, else what the example shows.
  const sample: PayloadCell | undefined = live?.preview.map((r) => r.actual[index]).find((v) => v !== null && v !== undefined && v !== '') ?? examples[0];

  // Text has no number or date format to choose: the section is only for numbers and dates (or a format the rules already carry).
  if (presets.length === 0 && current === undefined) return null;
  const setFormat = (format: string | null, coalesce?: string): void => {
    edit.run({ type: 'setColumnFormat', index, format }, coalesce ? { coalesce } : undefined);
  };

  const shown = formatPreview(current, sample, ctx.language);
  return (
    <FormSection title={t('editor.col.format')}>
      <SelectField
        label={t('editor.col.formatChoose')}
        value={mode}
        options={[
          { value: AS_IS, label: t('editor.col.formatAsIs') },
          // A format is left-to-right text whatever the page direction: marks keep its `#`, `,` and `.` in order.
          ...presets.map((p): Option => ({ value: p, label: `\u200e${p}\u200e` })),
          { value: CUSTOM, label: t('editor.col.formatCustom') },
        ]}
        onChange={(v) => {
          if (v === AS_IS) {
            setCustom(undefined);
            setFormat(null);
          } else if (v === CUSTOM) {
            setCustom(current ?? '');
          } else {
            setCustom(undefined);
            setFormat(v);
          }
        }}
      />
      {mode === CUSTOM && (
        <TextField
          mono
          dir="ltr"
          label={t('editor.col.formatText')}
          hint={t(type === 'date' ? 'editor.col.formatDateHint' : 'editor.col.formatNumberHint')}
          value={custom ?? current ?? ''}
          onChange={(v) => {
            setCustom(v);
            setFormat(v === '' ? null : v, 'format');
          }}
        />
      )}
      {sample !== undefined && (
        <p className="format-preview" aria-live="polite">
          <span className="field__label">{t('editor.col.formatPreview')}</span> <bdi className="tabular">{shown}</bdi>
        </p>
      )}
      <ProblemList problems={edit.problems} />
    </FormSection>
  );
}
