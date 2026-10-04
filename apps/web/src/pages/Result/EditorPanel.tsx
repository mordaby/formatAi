// The editor panel (SPEC 8.11): opens on the inline-end side when a line of the rules map is chosen, and as a
// full-width sheet on narrow screens. It picks the right editor for the line and shows what all of them share:
// "This changes the format for all N sources" and the Advanced view.
import { useState, type ReactNode } from 'react';
import { advancedJsonOf, lineIds } from '../../editor';
import { useI18n, type MessageKey } from '../../i18n';
import type { Line, LineTarget, RulesMapModel } from '../../rulesText';
import { Button, InlineMessage, Sheet } from '../../ui';
import type { LiveCheckResult } from '../../worker/editorApi';
import { CheckEditor } from './CheckEditor';
import { ColumnEditor } from './ColumnEditor';
import { ProblemList, useEdit, type EditorCtx } from './fields';
import { FileEditor, GroupEditor, SortEditor, SummaryRowEditor, TitleEditor } from './LayoutEditors';
import { DedupeEditor, ExpandEditor, FilterEditor, ReadAsEditor } from './RowEditors';
import { Sentence } from './Sentence';

export interface EditorPanelProps {
  ctx: EditorCtx;
  model: RulesMapModel;
  selectedId: string | null;
  advanced: boolean;
  live: LiveCheckResult | null | undefined;
  /** SPEC 8.12: a change to the output side of a conversion that belongs to a format. */
  formatChange: boolean;
  sourceCount: number;
  onClose(): void;
  onOpen(lineId: string): void;
  onAdvanced(on: boolean): void;
  onRenamed(header: string): void;
  onMoveColumn(from: number, to: number): void;
}

/** The lines that exist even when the rules have nothing in them (so the panel can stay open on them). */
const SINGLETONS: Record<string, LineTarget> = {
  [lineIds.dedupe]: { kind: 'dedupe' },
  [lineIds.sort]: { kind: 'sort' },
  [lineIds.group]: { kind: 'group' },
};

function findLine(model: RulesMapModel, id: string | null): Line | undefined {
  if (id === null) return undefined;
  for (const s of model.sections) for (const l of s.lines) if (l.id === id) return l;
  return undefined;
}

function titleOf(t: ReturnType<typeof useI18n>['t'], target: LineTarget): string {
  const n = (target.index ?? 0) + 1;
  switch (target.kind) {
    case 'column':
      return target.header ?? '';
    case 'readAs':
      return t('editor.title.readAs');
    case 'filter':
      return t('editor.title.filter', { n });
    case 'dedupe':
      return t('editor.title.dedupe');
    case 'expand':
      return t('editor.title.expand');
    case 'title':
      return t('editor.title.titleRow', { n });
    case 'sort':
      return t('editor.title.sort');
    case 'group':
    case 'blankRows':
      return t('editor.title.group');
    case 'summaryGroup':
      return t('editor.title.summaryGroup', { n });
    case 'summaryEnd':
      return t('editor.title.summaryEnd', { n });
    case 'file':
      return t('editor.title.file');
    case 'validation':
      return t('editor.title.check', { n });
    case 'function':
    case 'table':
      return target.name ?? '';
    case 'input':
      return t('editor.title.input');
  }
}

/** Shown beside the map when nothing is open (wide screens); on narrow screens nothing is shown until a line is chosen. */
export function EditorEmpty({ onAdvanced }: { onAdvanced(): void }) {
  const { t } = useI18n();
  return (
    <aside className="sheet sheet--empty" aria-label={t('editor.empty.title')}>
      <h2>{t('editor.empty.title')}</h2>
      <p className="muted">{t('editor.empty.text')}</p>
      <Button variant="link" onClick={onAdvanced}>
        {t('editor.advanced.open')}
      </Button>
    </aside>
  );
}

export function EditorPanel({ ctx, model, selectedId, advanced, live, formatChange, sourceCount, onClose, onOpen, onAdvanced, onRenamed, onMoveColumn }: EditorPanelProps) {
  const { t } = useI18n();
  const line = findLine(model, selectedId);
  const target = line?.target ?? (selectedId !== null ? SINGLETONS[selectedId] : undefined);

  if (advanced) {
    return (
      <Sheet title={t('editor.title.advanced')} onClose={onClose} className="editor">
        <div className="editor-tools">
          <Button variant="link" onClick={() => onAdvanced(false)}>
            {t('editor.advanced.back')}
          </Button>
        </div>
        {formatChange && <FormatChange sourceCount={sourceCount} />}
        <AdvancedEditor ctx={ctx} />
      </Sheet>
    );
  }
  if (!target) return null;

  const closeAfter = (): void => onClose();
  const index = target.index ?? 0;
  let body: ReactNode;
  switch (target.kind) {
    case 'column':
      body = (
        <ColumnEditor
          key={`col:${index}`}
          ctx={ctx}
          index={index}
          line={line}
          live={live}
          onRenamed={onRenamed}
          onRemoved={closeAfter}
          onMove={(delta) => onMoveColumn(index, index + delta)}
        />
      );
      break;
    case 'filter':
      body = <FilterEditor key={`filter:${index}`} ctx={ctx} index={index} onRemoved={closeAfter} />;
      break;
    case 'readAs': {
      const column = ctx.rules.input.columns[index];
      if (!column || target.name === undefined) return null;
      body = <ReadAsEditor key={line?.id} ctx={ctx} line={line} columnId={column.id} from={target.name} onRemoved={closeAfter} />;
      break;
    }
    case 'dedupe':
      body = <DedupeEditor ctx={ctx} />;
      break;
    case 'expand':
      body = <ExpandEditor ctx={ctx} onRemoved={closeAfter} />;
      break;
    case 'title':
      body = <TitleEditor key={`title:${index}`} ctx={ctx} index={index} onRemoved={closeAfter} />;
      break;
    case 'sort':
      body = <SortEditor ctx={ctx} />;
      break;
    case 'group':
    case 'blankRows':
      body = <GroupEditor ctx={ctx} onOpen={onOpen} />;
      break;
    case 'summaryGroup':
      body = <SummaryRowEditor key={`sg:${index}`} ctx={ctx} scope="group" index={index} onRemoved={closeAfter} />;
      break;
    case 'summaryEnd':
      body = <SummaryRowEditor key={`se:${index}`} ctx={ctx} scope="end" index={index} onRemoved={closeAfter} />;
      break;
    case 'file':
      body = <FileEditor ctx={ctx} />;
      break;
    case 'validation':
      body = <CheckEditor key={`check:${index}`} ctx={ctx} index={index} onRemoved={closeAfter} />;
      break;
    case 'function':
    case 'table':
      body = <ReadOnlyNote line={line} messageKey="editor.function.note" onAdvanced={() => onAdvanced(true)} />;
      break;
    case 'input':
      body = <ReadOnlyNote line={line} messageKey="editor.input.note" onAdvanced={() => onAdvanced(true)} />;
      break;
  }

  return (
    <Sheet title={titleOf(t, target)} onClose={onClose} className="editor">
      {formatChange && <FormatChange sourceCount={sourceCount} />}
      {body}
      <div className="editor-tools">
        <Button variant="link" onClick={() => onAdvanced(true)}>
          {t('editor.advanced.open')}
        </Button>
      </div>
    </Sheet>
  );
}

/** SPEC 8.12: a change to the output side of one source is a change to the format. */
export function FormatChange({ sourceCount }: { sourceCount: number }) {
  const { t } = useI18n();
  return (
    <InlineMessage tone="info" className="format-change">
      {t(sourceCount === 1 ? 'editor.formatChange.one' : 'editor.formatChange.other', { n: sourceCount })}
    </InlineMessage>
  );
}

function ReadOnlyNote({ line, messageKey, onAdvanced }: { line: Line | undefined; messageKey: MessageKey; onAdvanced(): void }) {
  const { t } = useI18n();
  return (
    <div className="editor-form">
      {line && (
        <p className="readonly-line">
          <Sentence parts={line.parts} />
        </p>
      )}
      <p className="muted">{t(messageKey)}</p>
      <div>
        <Button variant="secondary" size="sm" onClick={onAdvanced}>
          {t('editor.advanced.open')}
        </Button>
      </div>
    </div>
  );
}

// ---------- Advanced: the rules as text, checked when applied ----------

function AdvancedEditor({ ctx }: { ctx: EditorCtx }) {
  const { t } = useI18n();
  const [text, setText] = useState(() => advancedJsonOf(ctx.rules));
  const [applied, setApplied] = useState(false);
  const edit = useEdit(ctx, () => {
    setText(advancedJsonOf(ctx.rules));
    setApplied(false);
  });
  return (
    <div className="editor-form">
      <p className="muted">{t('editor.advanced.intro')}</p>
      <div className="field">
        <label className="field__label" htmlFor="advanced-json">
          {t('editor.advanced.label')}
        </label>
        <textarea
          id="advanced-json"
          className="input input--area input--code"
          dir="ltr"
          rows={20}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setApplied(false);
          }}
        />
      </div>
      <ProblemList problems={edit.problems} />
      <div className="row">
        <Button
          variant="secondary"
          onClick={() => {
            setApplied(edit.run({ type: 'setAdvancedJson', text }));
          }}
        >
          {t('editor.advanced.apply')}
        </Button>
        <span className="muted" role="status">
          {applied ? t('editor.advanced.applied') : ''}
        </span>
      </div>
    </div>
  );
}
