// Saving rules that hold what a saved format should not keep without asking (owner decisions 2026-10-06, "fewer clicks"; SPEC amendments "a
// list copied from the example is asked at Save" and v15 "what a saved format may keep", docs/proposals/saved-format-contents.md section 6).
// Nothing is asked while learning or converting: the rules are used as they are, and nothing is stored on the server until Save. At Save - only
// when the rules about to be stored hold a list of fixed values or an identifier-shaped value the server does not hold yet
// (`findingsToConfirm`) - ONE small dialog asks before anything is sent, neutrally (nothing about next month), a line per finding:
//   "Save this format?"
//   "Category is a list of 200 fixed values taken from your example (one for each Product code)."
//   "Target customer keeps an ID number in its rules."
//   "Keep these in the saved format?" - Keep them / Save without them / Cancel.
// One finding: its own question and answers ("Keep this list in the saved format?" - Keep it / Save without it). Keep saves as before. Save
// without takes them out (`withoutFindings`: each column needs your input, its values gone) in one undoable edit of the rules on screen, waits
// for the check of those rules - the status they are saved with is theirs - and saves them. Cancel (the button, Escape, the backdrop, the close
// button) saves nothing. With nothing to ask about the save goes at once: no extra click.
// Every screen that stores rules from a learn or the editor goes through it: the Result screen (Save format, then Save changes), Add a source,
// the saved source's editor.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isListFinding, withoutFindings, type EditableRules, type SaveFinding } from '../../editor';
import { useI18n } from '../../i18n';
import { Button, Dialog } from '../../ui';
import { Marked } from './Named';
import type { WorkbenchInfo } from './Workbench';

/** What the screen does to store the rules on screen (its own save: a new format, a new source, a new version). */
export type Persist = (info: WorkbenchInfo) => void;

export interface CopiedListGate {
  /** "Save without" is waiting for the check of the rules without the findings: the Save button shows it is busy. */
  waiting: boolean;
  /** Saves with `persist` at once when `findings` (`findingsToConfirm`) is empty; else asks first. */
  save(info: WorkbenchInfo, findings: readonly SaveFinding[], persist: Persist): void;
  /** The dialog and the wait: rendered with every render of the Workbench (in the screen's actions), so that it sees the rules as checked. */
  view(info: WorkbenchInfo): ReactNode;
}

interface Asking {
  info: WorkbenchInfo;
  findings: readonly SaveFinding[];
  persist: Persist;
}

interface Waiting {
  /** The rules without the findings, as the editor holds them: the save goes once their check is in. */
  rules: EditableRules;
  persist: Persist;
}

export function useCopiedListGate(): CopiedListGate {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const save = useCallback((info: WorkbenchInfo, findings: readonly SaveFinding[], persist: Persist): void => {
    if (findings.length === 0) persist(info);
    else setAsking({ info, findings, persist });
  }, []);

  const keep = (): void => {
    if (!asking) return;
    setAsking(null);
    asking.persist(asking.info);
  };
  const without = (): void => {
    if (!asking) return;
    const { info, findings, persist } = asking;
    setAsking(null);
    const store = info.editor.store;
    const next = withoutFindings(store.getState().rules, findings);
    // (the edit is checked like any other; one that is refused leaves the rules - and the server - as they were)
    if (!store.apply({ type: 'replaceRules', rules: next }).ok) return;
    setWaiting({ rules: store.getState().rules, persist });
  };
  const cancel = (): void => setAsking(null);
  const done = useCallback(() => setWaiting(null), []);

  const view = (info: WorkbenchInfo): ReactNode => (
    <>
      <SaveWhenChecked info={info} waiting={waiting} onDone={done} />
      {asking ? <CopiedListDialog findings={asking.findings} onKeep={keep} onWithout={without} onCancel={cancel} /> : null}
    </>
  );
  return { waiting: waiting !== null, save, view };
}

/**
 * "Save without": the save goes once the rules without the findings have been checked (`metaStatus`: the status they are saved with). Rules
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
  findings: readonly SaveFinding[];
  /**
   * Where the identifier-shaped values are: in the rules (the Save of a format or a source), or in the fixes "Do this every time?" is about to
   * save on the Run screen ("Qty keeps an ID number in its fixes"). Default `rules`.
   */
  identifiersIn?: 'rules' | 'fixes';
  onKeep(): void;
  onWithout(): void;
  onCancel(): void;
}

/**
 * "Save this format?": a line for each finding - a list (the column, how many values, the key column) or an identifier-shaped value (the
 * column and the kind found) - never a value; and one answer for all. The question and the answers follow what is asked about: one list, one
 * value, several lists, or several findings of any kind.
 */
export function CopiedListDialog({ findings, identifiersIn = 'rules', onKeep, onWithout, onCancel }: DialogProps) {
  const { t, lang } = useI18n();
  const many = findings.length > 1;
  const form = many ? (findings.every(isListFinding) ? 'other' : 'these') : isListFinding(findings[0]!) ? 'one' : 'value';
  const column = (header: string): ReactNode => (
    <strong>
      <bdi>{header}</bdi>
    </strong>
  );
  const line = (f: SaveFinding): ReactNode =>
    isListFinding(f) ? (
      <Marked
        id="copiedList.line"
        nodes={{
          column: column(f.header),
          n: <span className="tabular">{f.entries.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}</span>,
          key: <bdi>{f.keyColumn}</bdi>,
        }}
      />
    ) : (
      <Marked id={identifiersIn === 'fixes' ? 'copiedList.identifier.fix' : 'copiedList.identifier'} nodes={{ column: column(f.header), what: t(`copiedList.what.${f.idKind}`) }} />
    );
  const keyOf = (f: SaveFinding): string => (isListFinding(f) ? `list:${f.header}` : `${f.idKind}:${f.header}`);
  return (
    <Dialog open onClose={onCancel} title={t('copiedList.title')}>
      <div data-testid="copied-list-dialog">
        {many ? (
          <>
            <ul className="problem-list">
              {findings.map((f) => (
                <li key={keyOf(f)} data-column={f.header} data-kind={isListFinding(f) ? 'list' : f.idKind}>
                  {line(f)}
                </li>
              ))}
            </ul>
            <p>{t(`copiedList.ask.${form}`)}</p>
          </>
        ) : (
          <p data-column={findings[0]!.header} data-kind={isListFinding(findings[0]!) ? 'list' : findings[0]!.idKind}>
            {line(findings[0]!)} {t(`copiedList.ask.${form}`)}
          </p>
        )}
      </div>
      <div className="dialog__actions">
        {/* (neither answer is the "main" one: the words have no agenda, and neither do the buttons) */}
        <Button variant="secondary" onClick={onKeep} data-answer="keep">
          {t(`copiedList.keep.${form}`)}
        </Button>
        <Button variant="secondary" onClick={onWithout} data-answer="without">
          {t(`copiedList.without.${form}`)}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-answer="cancel">
          {t('copiedList.cancel')}
        </Button>
      </div>
    </Dialog>
  );
}
