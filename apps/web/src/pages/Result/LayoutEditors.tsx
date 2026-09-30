// Layout editors (SPEC 8.11): title rows, sort, groups and summary rows, and the output file.
import {
  OUTPUT_FILE_DELIMITERS,
  OUTPUT_FILE_ENCODINGS,
  OUTPUT_FILE_QUOTES,
  SUMMARY_AGGS,
  type OutputFile,
  type SortKey,
  type SummaryAgg,
  type SummaryRow,
  type TitleRow,
  type TitleRowPart,
} from '@formatai/shared';
import { useState } from 'react';
import { effectiveEndSummaryRows, effectiveGroupSummaryRows, lineIds, sourceOptions, type SummaryScope } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import { Button } from '../../ui';
import { CheckField, ChoiceGroup, FormSection, NumberField, ProblemList, SelectField, TextField, useEdit, type EditorCtx, type Option } from './fields';
import { RemoveButton } from './RowEditors';

// ---------- title rows ----------

export function TitleEditor({ ctx, index, onRemoved }: { ctx: EditorCtx; index: number; onRemoved(): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const row = rules.output.titleRows[index];
  const edit = useEdit(ctx);
  if (!row) return null;
  const dates = sourceOptions(rules).filter((s) => s.type === 'date');
  const dateChoices = dates.map((s): Option => ({ value: s.id, label: s.label }));
  const setRow = (next: TitleRow, coalesce?: string): void => {
    edit.run({ type: 'setTitleRows', rows: rules.output.titleRows.map((r, k) => (k === index ? next : r)) }, coalesce ? { coalesce } : undefined);
  };
  const bold = 'bold' in row ? row.bold === true : false;
  const withBold = (r: TitleRow, on: boolean): TitleRow => {
    if ('blank' in r) return r;
    const { bold: _bold, ...rest } = r;
    void _bold;
    return on ? { ...rest, bold: true } : rest;
  };
  const insertMonth = (column: string): void => void edit.run({ type: 'insertMonthFromDate', index, column });

  return (
    <div className="editor-form">
      {'blank' in row && <p className="muted">{t('editor.title.blank')}</p>}
      {'text' in row && (
        <>
          <TextField
            label={t('editor.title.text')}
            value={row.text}
            onChange={(text) => void edit.run({ type: 'setTitleText', index, text }, { coalesce: `title:${index}` })}
          />
          <CheckField label={t('editor.title.bold')} checked={bold} onChange={(on) => setRow(withBold(row, on))} />
        </>
      )}
      {'parts' in row && (
        <>
          <FormSection title={t('editor.title.parts')}>
            {row.parts.map((part, i) => (
              <div className="part" key={i}>
                {'text' in part ? (
                  <TextField
                    label={t('editor.title.partText', { n: i + 1 })}
                    value={part.text}
                    onChange={(text) => setRow({ ...row, parts: row.parts.map((p, k) => (k === i ? { text } : p)) }, `title:${index}:${i}`)}
                  />
                ) : (
                  <MonthPart
                    part={part}
                    n={i + 1}
                    choices={dateChoices}
                    onChange={(next) => setRow({ ...row, parts: row.parts.map((p, k) => (k === i ? next : p)) }, `title:${index}:${i}`)}
                  />
                )}
                {row.parts.length > 1 && (
                  <Button variant="ghost" size="sm" icon="close" aria-label={t('editor.title.removePart', { n: i + 1 })} onClick={() => setRow({ ...row, parts: row.parts.filter((_, k) => k !== i) })} />
                )}
              </div>
            ))}
            <div>
              <Button variant="ghost" size="sm" icon="plus" onClick={() => setRow({ ...row, parts: [...row.parts, { text: '' }] })}>
                {t('editor.title.addText')}
              </Button>
            </div>
          </FormSection>
          <CheckField label={t('editor.title.bold')} checked={bold} onChange={(on) => setRow(withBold(row, on))} />
        </>
      )}
      {!('blank' in row) && <InsertMonth choices={dateChoices} onInsert={insertMonth} />}
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.title.remove')} onClick={() => edit.run({ type: 'removeTitleRow', index }) && onRemoved()} />
    </div>
  );
}

/** "Insert month from [date column]": builds the title from the data, so next month's file gets next month's title (SPEC 8.7). */
function InsertMonth({ choices, onInsert }: { choices: Option[]; onInsert(column: string): void }) {
  const { t } = useI18n();
  const [column, setColumn] = useState(choices[0]?.value ?? '');
  if (choices.length === 0) return <p className="field__hint">{t('editor.title.noDates')}</p>;
  return (
    <div className="row row--end">
      <SelectField className="row__grow" label={t('editor.title.monthFrom')} value={choices.some((c) => c.value === column) ? column : (choices[0]?.value ?? '')} options={choices} onChange={setColumn} />
      <Button variant="secondary" size="sm" onClick={() => onInsert(choices.some((c) => c.value === column) ? column : (choices[0]?.value ?? ''))}>
        {t('editor.title.insertMonth')}
      </Button>
    </div>
  );
}

function MonthPart({ part, n, choices, onChange }: { part: Extract<TitleRowPart, { agg: 'min' | 'max' }>; n: number; choices: Option[]; onChange(next: TitleRowPart): void }) {
  const { t } = useI18n();
  return (
    <div className="editor-form__group">
      <SelectField
        label={t('editor.title.partAgg', { n })}
        value={part.agg}
        options={[
          { value: 'max', label: t('editor.title.agg.max') },
          { value: 'min', label: t('editor.title.agg.min') },
        ]}
        onChange={(agg) => onChange({ ...part, agg })}
      />
      <SelectField label={t('editor.title.partColumn', { n })} value={part.column} options={choices} onChange={(column) => onChange({ ...part, column })} />
      <TextField mono dir="ltr" label={t('editor.title.partFormat', { n })} hint={t('editor.col.formatDateHint')} value={part.format} onChange={(format) => onChange({ ...part, format })} />
    </div>
  );
}

// ---------- sort ----------

export function SortEditor({ ctx }: { ctx: EditorCtx }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const keys = rules.transform.sort;
  const edit = useEdit(ctx);
  const sources = sourceOptions(rules);
  const choices = sources.map((s): Option => ({ value: s.id, label: s.label }));
  const set = (next: SortKey[], coalesce?: string): void => void edit.run({ type: 'setSort', keys: next }, coalesce ? { coalesce } : undefined);
  const swap = (i: number, j: number): void => {
    const next = [...keys];
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    next[i] = b;
    next[j] = a;
    set(next);
  };
  const unused = sources.find((s) => !keys.some((k) => k.column === s.id));

  return (
    <div className="editor-form">
      {keys.length === 0 && <p className="muted">{t('editor.sort.none')}</p>}
      {keys.map((k, i) => (
        <div className="row row--end" key={`${k.column}`}>
          <SelectField className="row__grow" label={t('editor.sort.column', { n: i + 1 })} value={k.column} options={choices} onChange={(column) => set(keys.map((x, m) => (m === i ? { ...x, column } : x)))} />
          <SelectField
            label={t('editor.sort.dir', { n: i + 1 })}
            value={k.dir}
            options={[
              { value: 'asc', label: t('editor.sort.asc') },
              { value: 'desc', label: t('editor.sort.desc') },
            ]}
            onChange={(dir) => set(keys.map((x, m) => (m === i ? { ...x, dir } : x)))}
          />
          <Button variant="ghost" size="sm" icon="chevronUp" disabled={i === 0} aria-label={t('editor.sort.up', { n: i + 1 })} onClick={() => swap(i, i - 1)} />
          <Button variant="ghost" size="sm" icon="chevronDown" disabled={i === keys.length - 1} aria-label={t('editor.sort.down', { n: i + 1 })} onClick={() => swap(i, i + 1)} />
          <Button variant="ghost" size="sm" icon="close" aria-label={t('editor.sort.remove', { n: i + 1 })} onClick={() => set(keys.filter((_, m) => m !== i))} />
        </div>
      ))}
      {unused && (
        <div>
          <Button variant="ghost" size="sm" icon="plus" onClick={() => set([...keys, { column: unused.id, dir: 'asc' }])}>
            {t('editor.sort.add')}
          </Button>
        </div>
      )}
      <ProblemList problems={edit.problems} />
    </div>
  );
}

// ---------- groups ----------

export function GroupEditor({ ctx, onOpen }: { ctx: EditorCtx; onOpen(lineId: string): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const group = rules.transform.group;
  const edit = useEdit(ctx);
  const sources = sourceOptions(rules);
  const choices = sources.map((s): Option => ({ value: s.id, label: s.label }));
  const summaries = effectiveGroupSummaryRows(rules);

  if (!group) {
    const first = sources[0];
    return (
      <div className="editor-form">
        <p className="muted">{t('editor.group.off')}</p>
        {first && (
          <div>
            <Button variant="secondary" size="sm" onClick={() => edit.run({ type: 'setGroup', group: { by: first.id, showDetailRows: true } })}>
              {t('editor.group.turnOn')}
            </Button>
          </div>
        )}
        <ProblemList problems={edit.problems} />
      </div>
    );
  }

  const set = (patch: Partial<typeof group>, coalesce?: string): void =>
    void edit.run(
      { type: 'setGroup', group: { by: patch.by ?? group.by, showDetailRows: patch.showDetailRows ?? group.showDetailRows, ...('blankRowsAfter' in patch ? (patch.blankRowsAfter === undefined ? {} : { blankRowsAfter: patch.blankRowsAfter }) : group.blankRowsAfter === undefined ? {} : { blankRowsAfter: group.blankRowsAfter }) } },
      coalesce ? { coalesce } : undefined,
    );

  return (
    <div className="editor-form">
      <SelectField label={t('editor.group.by')} value={group.by} options={choices} onChange={(by) => set({ by })} />
      <CheckField label={t('editor.group.detail')} hint={t('editor.group.detailHint')} checked={group.showDetailRows} onChange={(showDetailRows) => set({ showDetailRows })} />
      <NumberField label={t('editor.group.blank')} min={0} max={20} value={group.blankRowsAfter ?? 0} onChange={(n) => set({ blankRowsAfter: n === undefined || n === 0 ? undefined : n }, 'blank')} />
      <FormSection title={t('editor.group.summaries')}>
        {summaries.length === 0 && <p className="muted">{t('editor.group.noSummaries')}</p>}
        {summaries.map((_, i) => (
          <div key={i}>
            <Button variant="link" onClick={() => onOpen(lineIds.summaryGroup(i))}>
              {t('editor.group.openSummary', { n: i + 1 })}
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            onClick={() => {
              const numeric = rules.output.columns[0];
              if (!numeric) return;
              if (edit.run({ type: 'addSummaryRow', scope: 'group', row: { label: t('editor.summary.defaultLabel'), cells: { [numeric.header]: 'count' } } })) onOpen(lineIds.summaryGroup(summaries.length));
            }}
          >
            {t('editor.group.addSummary')}
          </Button>
        </div>
      </FormSection>
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.group.remove')} onClick={() => void edit.run({ type: 'setGroup', group: null })} />
    </div>
  );
}

// ---------- summary rows ----------

export function SummaryRowEditor({ ctx, scope, index, onRemoved }: { ctx: EditorCtx; scope: SummaryScope; index: number; onRemoved(): void }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const row = (scope === 'end' ? effectiveEndSummaryRows(rules) : effectiveGroupSummaryRows(rules))[index];
  const edit = useEdit(ctx);
  if (!row) return null;
  const headers = rules.output.columns.map((c) => c.header);
  const set = (next: SummaryRow, coalesce?: string): void => void edit.run({ type: 'updateSummaryRow', scope, index, row: next }, coalesce ? { coalesce } : undefined);
  const clean = (r: SummaryRow): SummaryRow => {
    const { label, labelColumn, bold, cells } = r;
    return { ...(label === undefined || label === '' ? {} : { label }), ...(labelColumn === undefined ? {} : { labelColumn }), ...(bold ? { bold: true } : {}), cells };
  };

  return (
    <div className="editor-form">
      <TextField label={t('editor.summary.label')} value={row.label ?? ''} onChange={(label) => set(clean({ ...row, label }), `summary:${scope}:${index}`)} />
      <SelectField
        label={t('editor.summary.labelColumn')}
        value={row.labelColumn ?? ''}
        placeholder={t('editor.summary.firstFree')}
        options={headers.map((h): Option => ({ value: h, label: h }))}
        onChange={(labelColumn) => set(clean({ ...row, labelColumn }))}
      />
      <CheckField label={t('editor.summary.bold')} checked={row.bold === true} onChange={(bold) => set(clean({ ...row, bold }))} />
      <FormSection title={t('editor.summary.cells')}>
        {headers.map((h) => (
          <SelectField
            key={h}
            label={<bdi>{h}</bdi>}
            value={row.cells[h] ?? ''}
            options={[{ value: '', label: t('editor.summary.none') }, ...SUMMARY_AGGS.map((a): Option => ({ value: a, label: t(`editor.summary.agg.${a}` as MessageKey) }))]}
            onChange={(agg) => {
              const cells = { ...row.cells };
              if (agg === '') delete cells[h];
              else cells[h] = agg as SummaryAgg;
              set(clean({ ...row, cells }));
            }}
          />
        ))}
      </FormSection>
      <ProblemList problems={edit.problems} />
      <RemoveButton label={t('editor.summary.remove')} onClick={() => edit.run({ type: 'removeSummaryRow', scope, index }) && onRemoved()} />
    </div>
  );
}

// ---------- the output file ----------

const FILE_TYPES = ['xlsx', 'csv', 'txt'] as const;

export function FileEditor({ ctx }: { ctx: EditorCtx }) {
  const { t } = useI18n();
  const { rules } = ctx;
  const out = rules.output;
  const file: OutputFile = out.file ?? { type: 'xlsx' };
  const edit = useEdit(ctx);
  const patch = (p: Parameters<typeof edit.run>[0] & { type: 'setOutputOptions' }, coalesce?: string): void => void edit.run(p, coalesce ? { coalesce } : undefined);
  const setFile = (next: OutputFile): void => patch({ type: 'setOutputOptions', patch: { file: next } });

  return (
    <div className="editor-form">
      <ChoiceGroup
        label={t('editor.file.type')}
        value={file.type}
        options={FILE_TYPES.map((f): Option<(typeof FILE_TYPES)[number]> => ({ value: f, label: t(`editor.file.type.${f}` as MessageKey) }))}
        onChange={(type) => setFile(type === 'xlsx' ? { type } : { type, delimiter: type === 'txt' ? '\t' : ',', header: true, encoding: 'utf8bom', quote: 'minimal' })}
      />
      {file.type === 'xlsx' ? (
        <>
          <TextField label={t('editor.file.sheetName')} value={out.sheetName} onChange={(sheetName) => patch({ type: 'setOutputOptions', patch: { sheetName } }, 'sheetName')} />
          <ChoiceGroup
            label={t('editor.file.direction')}
            value={out.direction}
            options={[
              { value: 'ltr', label: t('editor.file.direction.ltr') },
              { value: 'rtl', label: t('editor.file.direction.rtl') },
            ]}
            onChange={(direction) => patch({ type: 'setOutputOptions', patch: { direction } })}
          />
          <CheckField label={t('editor.file.headerBold')} checked={out.headerStyle?.bold === true} onChange={(headerBold) => patch({ type: 'setOutputOptions', patch: { headerBold } })} />
        </>
      ) : (
        <>
          <SelectField
            label={t('editor.file.delimiter')}
            value={file.delimiter ?? (file.type === 'txt' ? '\t' : ',')}
            options={OUTPUT_FILE_DELIMITERS.map((d): Option => ({ value: d, label: t(`editor.file.delimiter.${d === '\t' ? 'tab' : d === ',' ? 'comma' : d === ';' ? 'semicolon' : 'pipe'}` as MessageKey) }))}
            onChange={(delimiter) => setFile({ ...file, delimiter: delimiter as NonNullable<OutputFile['delimiter']> })}
          />
          <CheckField label={t('editor.file.header')} checked={file.header ?? true} onChange={(header) => setFile({ ...file, header })} />
          <SelectField
            label={t('editor.file.encoding')}
            value={file.encoding ?? 'utf8bom'}
            options={OUTPUT_FILE_ENCODINGS.map((e): Option => ({ value: e, label: t(`editor.file.encoding.${e}` as MessageKey) }))}
            onChange={(encoding) => setFile({ ...file, encoding: encoding as NonNullable<OutputFile['encoding']> })}
          />
          <SelectField
            label={t('editor.file.quote')}
            value={file.quote ?? 'minimal'}
            options={OUTPUT_FILE_QUOTES.map((q): Option => ({ value: q, label: t(`editor.file.quote.${q}` as MessageKey) }))}
            onChange={(quote) => setFile({ ...file, quote: quote as NonNullable<OutputFile['quote']> })}
          />
        </>
      )}
      <ChoiceGroup
        label={t('editor.file.language')}
        value={out.language}
        options={[
          { value: 'en', label: t('editor.file.language.en') },
          { value: 'he', label: t('editor.file.language.he') },
        ]}
        onChange={(language) => patch({ type: 'setOutputOptions', patch: { language } })}
      />
      <ProblemList problems={edit.problems} />
    </div>
  );
}
