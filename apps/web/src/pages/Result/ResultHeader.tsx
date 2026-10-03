// The Result screen's header: the format's name (renameable in place), the status badge, undo and redo, "Unsaved changes" while the
// rules differ from the saved (or learned) ones, and the one primary button (SPEC 16.1 screen 4).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Badge, Button, Icon, Spinner, type BadgeTone } from '../../ui';

export interface StatusBadgeProps {
  tone: BadgeTone;
  text: string;
  busy?: boolean;
}

export function StatusBadge({ tone, text, busy }: StatusBadgeProps) {
  return (
    <span data-testid="status-badge" className="result-head__badge" role="status">
      <Badge tone={tone}>
        {busy && <Spinner size={12} />}
        {text}
      </Badge>
    </span>
  );
}

/** The format's name, written in the title. Click (or Enter) to rename it in place; Enter or leaving the field keeps it, Escape goes back. */
function FormatName({ name, onRename }: { name: string; onRename(name: string): void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = (): void => {
    const next = text.trim();
    if (next !== '' && next !== name) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="format-name__input"
        aria-label={t('result.nameLabel')}
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setText(name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="format-name"
      aria-label={t('result.rename', { name })}
      onClick={() => {
        setText(name);
        setEditing(true);
      }}
    >
      <Cell value={name} />
      <Icon name="pencil" size={16} />
    </button>
  );
}

export interface ResultHeaderProps {
  name: string;
  /** Without it the title is plain text (a saved source is renamed from its format's page). */
  onRename?: ((name: string) => void) | undefined;
  badge: ReactNode;
  /** How the format was learned: on this computer, or with the server's help (the privacy line under the title). */
  learnedNote: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  /** The rules differ from the last saved (or learned) version: "Unsaved changes" sits next to the Save button. */
  unsaved?: boolean | undefined;
  /** The header's primary action(s): "Save format and download", "Finish with the AI step", "Save changes", and the line under it. */
  actions: ReactNode;
}

export function ResultHeader({ name, onRename, badge, learnedNote, canUndo, canRedo, onUndo, onRedo, unsaved, actions }: ResultHeaderProps) {
  const { t } = useI18n();
  return (
    <header className="result-head">
      <div className="result-head__heading">
        <div className="result-head__title">
          <h1>{onRename ? <FormatName name={name} onRename={onRename} /> : <Cell value={name} />}</h1>
          {badge}
        </div>
        <p className="muted">{learnedNote}</p>
      </div>
      <div className="result-head__actions">
        <div className="result-head__history" role="group" aria-label={t('result.history')}>
          <Button variant="ghost" size="sm" icon="undo" disabled={!canUndo} onClick={onUndo} aria-label={t('result.undo')} title={t('result.undo')} />
          <Button variant="ghost" size="sm" icon="redo" disabled={!canRedo} onClick={onRedo} aria-label={t('result.redo')} title={t('result.redo')} />
        </div>
        {/* Always in the page (empty when there is nothing to say), so a screen reader hears it appear. */}
        <span className="result-head__unsaved" role="status" data-testid="unsaved-changes">
          {unsaved ? (
            <>
              <Icon name="pencil" size={16} />
              {t('result.unsaved')}
            </>
          ) : null}
        </span>
        <div className="result-head__save">{actions}</div>
      </div>
    </header>
  );
}
