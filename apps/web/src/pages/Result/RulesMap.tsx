import { aiStepPartMessages, type AiStepPartCode } from '@formatai/shared';
import { useId, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { EditableRules } from '../../editor';
import { localize, useI18n, type MessageKey } from '../../i18n';
import type { Line, LineStatus, RulesMapModel, Section, SectionId } from '../../rulesText';
import { Button, Icon, type IconName } from '../../ui';
import type { ColumnCheck } from '../../worker/editorApi';
import { canKeep, type AddKind } from './helpers';
import { Sentence } from './Sentence';

export interface RulesMapProps {
  model: RulesMapModel;
  rules: EditableRules;
  selectedId: string | null;
  /** Per output column, from the live check (position in `rules.output.columns`). */
  columnChecks: readonly ColumnCheck[] | undefined;
  /** The lines are filling in one by one (learning has just finished). */
  intro: boolean;
  onSelect(line: Line): void;
  onKeep(line: Line): void;
  onReorder(from: number, to: number): void;
  onAdd(kind: AddKind): void;
  /**
   * SPEC 21 v5 item 1 (the local result before the AI step): the output columns (headers) and the layout parts code could
   * not work out. The columns are marked "Needs the AI step" in the map; the parts are listed in a section of their own.
   */
  aiStep?: { columns: ReadonlySet<string>; parts: readonly AiStepPartCode[] } | undefined;
  /** No example is in memory (a saved source opened for editing): a tick says "no problem found", not "matches your example". */
  noExample?: boolean | undefined;
}

const STATUS_ICON: Record<LineStatus, IconName> = { matches: 'check', check: 'alert', needsInput: 'alert', edited: 'pencil' };
const STATUS_TEXT: Record<LineStatus, MessageKey> = {
  matches: 'map.status.matches',
  check: 'map.status.check',
  needsInput: 'map.status.needsInput',
  edited: 'map.status.edited',
};

function StatusIcon({ status, label }: { status: LineStatus; label?: string }) {
  const { t } = useI18n();
  return (
    <span className={`status status--${status}`}>
      <Icon name={STATUS_ICON[status]} size={16} title={label ?? t(STATUS_TEXT[status])} />
    </span>
  );
}

/** Which "Add ..." buttons a section offers, given what the rules already have. */
function addButtons(id: SectionId, rules: EditableRules): { kind: AddKind; label: MessageKey }[] {
  switch (id) {
    case 'rows':
      return [
        { kind: 'filter', label: 'map.add.filter' },
        ...(rules.transform.dedupe ? [] : [{ kind: 'dedupe' as const, label: 'map.add.dedupe' as const }]),
      ];
    case 'columns':
      return [{ kind: 'column', label: 'map.add.column' }];
    case 'layout':
      return [
        { kind: 'title', label: 'map.add.title' },
        ...(rules.transform.sort.length > 0 ? [] : [{ kind: 'sort' as const, label: 'map.add.sort' as const }]),
        ...(rules.transform.group ? [] : [{ kind: 'group' as const, label: 'map.add.group' as const }]),
        { kind: 'summaryEnd', label: 'map.add.summary' },
      ];
    case 'checks':
      return [{ kind: 'check', label: 'map.add.check' }];
    default:
      return [];
  }
}

interface DragState {
  from: number;
  over: number | null;
  edge: 'before' | 'after';
}

export function RulesMap({ model, rules, selectedId, columnChecks, intro, onSelect, onKeep, onReorder, onAdd, aiStep, noExample }: RulesMapProps) {
  const { t, lang } = useI18n();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState('');
  let lineNumber = 0;

  const move = (from: number, to: number, name: string): void => {
    if (to < 0 || to >= rules.output.columns.length || to === from) return;
    onReorder(from, to);
    setAnnounce(t('map.moved', { name, n: to + 1, total: rules.output.columns.length }));
  };

  return (
    <div className="map" data-testid="rules-map">
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
      {model.sections.map((section) => (
        <MapSection key={section.id} section={section} add={addButtons(section.id, rules)} onAdd={onAdd}>
          {section.lines.map((line) => {
            const n = lineNumber++;
            const isColumn = line.target.kind === 'column' && line.target.index !== undefined;
            const needsAi = isColumn && aiStep?.columns.has(line.target.header ?? '') === true;
            return (
              <MapLine
                key={line.id}
                line={line}
                keepable={canKeep(rules, line)}
                selected={selectedId === line.id}
                check={isColumn && !needsAi ? columnChecks?.[line.target.index!] : undefined}
                needsAi={needsAi}
                noExample={noExample === true}
                intro={intro}
                order={n}
                draggable={isColumn}
                drag={isColumn && drag && drag.over === line.target.index ? drag.edge : undefined}
                dragging={isColumn && drag?.from === line.target.index}
                onSelect={onSelect}
                onKeep={onKeep}
                onDragStart={(index) => setDrag({ from: index, over: null, edge: 'before' })}
                onDragOver={(index, edge) => setDrag((d) => (d ? { ...d, over: index, edge } : d))}
                onDrop={(index, edge) => {
                  if (drag) {
                    const position = edge === 'before' ? index : index + 1;
                    const to = position > drag.from ? position - 1 : position;
                    move(drag.from, to, line.target.header ?? '');
                  }
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
                onMove={(delta) => move(line.target.index!, line.target.index! + delta, line.target.header ?? '')}
              />
            );
          })}
        </MapSection>
      ))}
      {aiStep && aiStep.parts.length > 0 && (
        <section className="map-section map-section--ai" data-section="aiStep" data-testid="ai-step-parts">
          <h2 className="map-section__title">{t('partial.section')}</h2>
          <p className="muted">{t('partial.section.lead')}</p>
          <ul className="ai-parts">
            {aiStep.parts.map((code) => (
              <li key={code} data-part={code}>
                <Icon name="alert" size={16} />
                <span>{localize(lang, aiStepPartMessages[code])}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {model.notes.length > 0 && (
        <ul className="map-notes">
          {model.notes.map((note, i) => (
            <li key={i}>
              <Icon name="alert" size={16} />
              <span>
                {note.column ? <bdi className="sentence__name">{note.column}</bdi> : null}
                {note.column ? ': ' : ''}
                {note.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MapSection({
  section,
  add,
  onAdd,
  children,
}: {
  section: Section;
  add: { kind: AddKind; label: MessageKey }[];
  onAdd(kind: AddKind): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <section className="map-section" aria-labelledby={headingId} data-section={section.id}>
      <h2 className="map-section__title" id={headingId}>
        {section.title}
      </h2>
      {section.lines.length > 0 ? <ol className="map-lines">{children}</ol> : <p className="map-section__empty">{t(`map.empty.${section.id}` as MessageKey)}</p>}
      {add.length > 0 && (
        <div className="map-section__add">
          {add.map((a) => (
            <Button key={a.kind} variant="ghost" size="sm" icon="plus" onClick={() => onAdd(a.kind)}>
              {t(a.label)}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

interface MapLineProps {
  line: Line;
  keepable: boolean;
  selected: boolean;
  check: ColumnCheck | undefined;
  /** The AI step still has to work this column out (SPEC 21 v5). */
  needsAi: boolean;
  noExample: boolean;
  intro: boolean;
  order: number;
  draggable: boolean;
  drag: 'before' | 'after' | undefined;
  dragging: boolean;
  onSelect(line: Line): void;
  onKeep(line: Line): void;
  onDragStart(index: number): void;
  onDragOver(index: number, edge: 'before' | 'after'): void;
  onDrop(index: number, edge: 'before' | 'after'): void;
  onDragEnd(): void;
  onMove(delta: number): void;
}

function MapLine({ line, keepable, selected, check, needsAi, noExample, intro, order, draggable, drag, dragging, onSelect, onKeep, onDragStart, onDragOver, onDrop, onDragEnd, onMove }: MapLineProps) {
  const { t } = useI18n();
  const index = line.target.index ?? 0;
  const name = line.target.header ?? '';
  const differs = check !== undefined && check.inExample && check.matched < check.total;
  const showCount = check !== undefined && check.inExample && check.total > 0;
  const attention = line.status === 'check' || line.status === 'needsInput' || needsAi;
  const statusLabel = needsAi ? t('partial.section') : noExample && line.status === 'matches' ? t('map.status.unchecked') : t(STATUS_TEXT[line.status]);
  const reason = needsAi ? t('partial.line.reason') : line.statusReason;

  const edgeOf = (e: DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onMove(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <li
      className={['map-line', intro ? 'map-line--intro' : ''].filter(Boolean).join(' ')}
      style={{ '--i': Math.min(order, 28) } as CSSProperties}
      data-line-id={line.id}
      data-status={line.status}
      data-ai-step={needsAi || undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-drop={drag}
      onDragOver={
        draggable
          ? (e) => {
              e.preventDefault();
              onDragOver(index, edgeOf(e));
            }
          : undefined
      }
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDrop(index, edgeOf(e));
            }
          : undefined
      }
    >
      <div className="map-line__row">
        {draggable && (
          <button
            type="button"
            className="map-line__grip"
            draggable
            aria-label={t('map.move', { name })}
            title={t('map.moveHint')}
            onKeyDown={onGripKey}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(index));
              const row = e.currentTarget.closest('li');
              if (row && typeof e.dataTransfer.setDragImage === 'function') e.dataTransfer.setDragImage(row, 16, 16);
              onDragStart(index);
            }}
            onDragEnd={onDragEnd}
          >
            <Icon name="grip" size={16} />
          </button>
        )}
        <button type="button" className="map-line__main" aria-current={selected ? 'true' : undefined} onClick={() => onSelect(line)}>
          <StatusIcon status={line.status} {...(needsAi ? { label: t('partial.section') } : noExample && line.status === 'matches' ? { label: t('map.status.unchecked') } : {})} />
          <span className="map-line__text">
            <Sentence parts={line.parts} />
          </span>
          {showCount && (
            <span className="map-line__count" data-differs={differs || undefined} title={t('map.count.title', { matched: check!.matched, total: check!.total })}>
              {check!.matched}/{check!.total}
            </span>
          )}
        </button>
      </div>
      {attention && reason && (
        <div className="map-line__note">
          <p>
            <span className="map-line__notelabel">{statusLabel}</span> {reason}
          </p>
          <div className="map-line__actions">
            {keepable && (
              <Button variant="secondary" size="sm" onClick={() => onKeep(line)}>
                {t('map.keep')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => onSelect(line)}>
              {t(line.status === 'needsInput' || needsAi ? 'map.fill' : 'map.change')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
