// Saving rules that hold a list copied from the example (owner decision 2026-10-06, "fewer clicks"; SPEC amendment "a list copied from the
// example is asked at Save"). Nothing is asked while learning or converting: the list is used as it is, and nothing is stored on the server
// until Save. At Save - only when the rules about to be stored hold such a list the server does not hold yet (`listsToConfirm`) - one small
// dialog asks before anything is sent, neutrally (nothing about next month):
//   "Save this format?" - "<Column> was learned as a list copied from your example (40 values, one for each Account). Keep this list in the
//   saved format?" - Keep it / Save without it / Cancel. Several lists: a line each, and one answer for all (Keep them / Save without them).
// Keep saves as before. Save without takes the lists out (`withoutCopiedLists`: each column needs your input, its copied values gone) in one
// undoable edit of the rules on screen, waits for the check of those rules - the status they are saved with is theirs - and saves them. Cancel
// (the button, Escape, the backdrop, the close button) saves nothing. With no list to ask about the save goes at once: no extra click.
// Every screen that stores rules from a learn goes through it: the Result screen (Save format, then Save changes), Add a source.
import type { CopiedListQuestion } from '@formatai/engine';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { withoutCopiedLists, type EditableRules } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, Dialog } from '../../ui';
import { Marked } from './Named';
import type { WorkbenchInfo } from './Workbench';

/** What the screen does to store the rules on screen (its own save: a new format, a new source, a new version). */
export type Persist = (info: WorkbenchInfo) => void;

export interface CopiedListGate {
  /** "Save without" is waiting for the check of the rules without the lists: the Save button shows it is busy. */
  waiting: boolean;
  /** Saves with `persist` at once when `lists` (`listsToConfirm`) is empty; else asks first. */
  save(info: WorkbenchInfo, lists: readonly CopiedListQuestion[], persist: Persist): void;
  /** The dialog and the wait: rendered with every render of the Workbench (in the screen's actions), so that it sees the rules as checked. */
  view(info: WorkbenchInfo): ReactNode;
}

interface Asking {
  info: WorkbenchInfo;
  lists: readonly CopiedListQuestion[];
  persist: Persist;
}

interface Waiting {
  /** The rules without the lists, as the editor holds them: the save goes once their check is in. */
  rules: EditableRules;
  persist: Persist;
}

export function useCopiedListGate(): CopiedListGate {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const save = useCallback((info: WorkbenchInfo, lists: readonly CopiedListQuestion[], persist: Persist): void => {
    if (lists.length === 0) persist(info);
    else setAsking({ info, lists, persist });
  }, []);

  const keep = (): void => {
    if (!asking) return;
    setAsking(null);
    asking.persist(asking.info);
  };
  const without = (): void => {
    if (!asking) return;
    const { info, lists, persist } = asking;
    setAsking(null);
    const store = info.editor.store;
    const next = withoutCopiedLists(store.getState().rules, lists);
    // (the edit is checked like any other; one that is refused leaves the rules - and the server - as they were)
    if (!store.apply({ type: 'replaceRules', rules: next }).ok) return;
    setWaiting({ rules: store.getState().rules, persist });
  };
  const cancel = (): void => setAsking(null);
  const done = useCallback(() => setWaiting(null), []);

  const view = (info: WorkbenchInfo): ReactNode => (
    <>
      <SaveWhenChecked info={info} waiting={waiting} onDone={done} />
      {asking ? <CopiedListDialog lists={asking.lists} onKeep={keep} onWithout={without} onCancel={cancel} /> : null}
    </>
  );
  return { waiting: waiting !== null, save, view };
}

/**
 * "Save without": the save goes once the rules without the lists have been checked (`metaStatus`: the status they are saved with). Rules
 * changed meanwhile (an undo), or that cannot be saved (a problem, a check that failed), are not sent: the screen says why, Save is there.
 */
function SaveWhenChecked({ info, waiting, onDone }: { info: WorkbenchInfo; waiting: Waiting | null; onDone(): void }) {
  const latest = useRef(info);
  latest.current = info;
  const { rules, metaStatus } = info;
  const kind = info.status.kind;
  useEffect(() => {
    if (!waiting) return;
    if (rules !== waiting.rules || kind === 'blocked' || kind === 'checkFailed') {
      onDone();
      return;
    }
    if (metaStatus === null) return;
    onDone();
    waiting.persist(latest.current);
  }, [waiting, rules, metaStatus, kind, onDone]);
  return null;
}

interface DialogProps {
  lists: readonly CopiedListQuestion[];
  onKeep(): void;
  onWithout(): void;
  onCancel(): void;
}

/** "Save this format?": a line for each list (the column, how many values, the key column - no value of the list), and one answer for all. */
export function CopiedListDialog({ lists, onKeep, onWithout, onCancel }: DialogProps) {
  const { t, lang } = useI18n();
  const many = lists.length > 1;
  const line = (q: CopiedListQuestion): ReactNode => (
    <Marked
      id="copiedList.line"
      nodes={{
        column: (
          <strong>
            <bdi>{q.header}</bdi>
          </strong>
        ),
        n: <span className="tabular">{q.entries.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}</span>,
        key: <bdi>{q.keyColumn}</bdi>,
      }}
    />
  );
  return (
    <Dialog open onClose={onCancel} title={t('copiedList.title')}>
      <div data-testid="copied-list-dialog">
        {many ? (
          <>
            <ul className="problem-list">
              {lists.map((q) => (
                <li key={q.header} data-column={q.header}>
                  {line(q)}
                </li>
              ))}
            </ul>
            <p>{t('copiedList.ask.other')}</p>
          </>
        ) : (
          <p data-column={lists[0]!.header}>
            {line(lists[0]!)} {t('copiedList.ask.one')}
          </p>
        )}
      </div>
      <div className="dialog__actions">
        {/* (neither answer is the "main" one: the words have no agenda, and neither do the buttons) */}
        <Button variant="secondary" onClick={onKeep} data-answer="keep">
          {t(many ? 'copiedList.keep.other' : 'copiedList.keep.one')}
        </Button>
        <Button variant="secondary" onClick={onWithout} data-answer="without">
          {t(many ? 'copiedList.without.other' : 'copiedList.without.one')}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-answer="cancel">
          {t('copiedList.cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
