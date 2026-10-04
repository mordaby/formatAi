// The working part of the Result screen (SPEC 8.11, 16.1 screen 4): the header, the live check, the rules map with its editor, the
// preview grid and the flagged rows. It does not know where the rules came from - a fresh learn, a source being added to a
// format, or a saved source opened for editing - or what "save" means there: the caller passes the header's actions, banners
// and (when there is no example in memory) what replaces the preview.
import { missingParts, type AiColumnNote, type AiStepPartCode, type Format, type SourceStructure, type Tier } from '@formatai/shared';
import type { AmbiguousColumn, PartialInfo } from '@formatai/engine';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LeaveGuard } from '../../app/LeaveGuard';
import { applyReading, availableInputs, lineIds, lockProblem, questionOpen, useEditor, useLiveCheck, metaStatusOf, differencesOf, type ApplyActionOptions, type EditLock, type EditableRules, type EditAction, type EditorStore, type ExampleInputColumn, type SaveStatus, type UseEditor, type UseLiveCheck } from '../../editor';
import { normalizeHeader } from '../../editor/rulesUtil';
import { useI18n } from '../../i18n';
import { describeRules, type Line, type VerificationLike } from '../../rulesText';
import { useServices } from '../../services';
import { Button, Stepper } from '../../ui';
import type { LiveCheckResult } from '../../worker/editorApi';
import { EditorEmpty, EditorPanel } from './EditorPanel';
import type { EditorCtx } from './fields';
import { FlagsList } from './FlagsList';
import { assumptionIndexes, columnMismatches, columnsWithoutRule, planAdd, type AddKind } from './helpers';
import { LiveCheckStrip } from './LiveCheckStrip';
import { PreviewGrid } from './PreviewGrid';
import { ReadingQuestion } from './ReadingQuestion';
import { ResultHeader, StatusBadge } from './ResultHeader';
import { RulesMap } from './RulesMap';
import { useApplied } from './useApplied';
import { useRunFlags } from './useRunFlags';

/** How long the map takes to fill in line by line after learning (the screen's one orchestrated motion). */
const INTRO_MS = 1800;

/** What the caller needs to know to decide what "save" (or "finish") means right now. */
export interface WorkbenchInfo {
  rules: EditableRules;
  exceptions: number[];
  /** The Save button's status: verified, differences (N), blocked by problems, still checking... */
  status: SaveStatus;
  /** The `meta.status` a save would get; null while it cannot be saved (blocked, still checking). */
  metaStatus: ReturnType<typeof metaStatusOf>;
  /** N of "Save with N differences", or null. */
  differences: number | null;
  live: LiveCheckResult | null;
  /** Output columns that still have nothing to fill them. */
  needsInput: ReadonlySet<string>;
  /** Differs from what was last saved (or opened). */
  dirty: boolean;
  /** The output side changed: for a source of a format this is a change to the format (SPEC 8.12). */
  formatChange: boolean;
  sourceCount: number;
  /** The input side changed (SPEC 8.15): for a source that feeds several formats this is a change to all of them. */
  sourceChange: boolean;
  /** How many formats the conversion's source feeds (1 when that isn't known). */
  sourceFormats: number;
  editor: UseEditor;
  check: UseLiveCheck;
  /** Opens a line of the rules map in the editor (`lineIds`): "Fix the rule". */
  openLine(id: string): void;
}

export interface WorkbenchProps {
  /** The edits and their undo history live outside the component, so they survive leaving the screen and the sign-in wall. */
  store: EditorStore;
  /** Undefined: no example is in memory; only the static checks run. */
  exampleId: string | undefined;
  /**
   * The example INPUT's columns (from the learn, or from the example files dropped again): every source dropdown offers the ones no
   * rule uses yet. Undefined: none is known (a saved source without example files), and a column can be typed in by its header.
   */
  exampleInput?: readonly ExampleInputColumn[] | undefined;
  /** The example INPUT file, for the flagged rows a real run would give. */
  inputFile: File | null;
  tier: Tier;
  /** Inside a format: turns on the format lock (SPEC 8.12). */
  format?: Format | undefined;
  /** An existing source the user chose for a conversion that is not saved yet: turns on the source lock (SPEC 8.15). */
  source?: SourceStructure | undefined;
  /** SPEC 21 v5 item 1: the local partial result (columns the AI step still has to work out are marked, and only the built ones are checked). */
  partial?: PartialInfo | undefined;
  /**
   * The deep analysis with AI is working on these fields (output column headers, layout parts): they say so on the map and cannot be edited
   * until it is done - nor can the shape of the columns, nor undo - while the rest of the page stays usable (`EditorStore.setLock`).
   * `whole`: it is a whole learn, so nothing can be edited.
   */
  analysing?: { columns: ReadonlySet<string>; parts: readonly AiStepPartCode[]; whole?: boolean } | undefined;
  /** The learn's own verification, shown in the map until the live check answers. */
  verification?: VerificationLike | null | undefined;
  /** learn-v7: what the AI step noted about the columns it could not build (its guess, a recorded function request): shown in the session only. */
  aiNotes?: ReadonlyMap<string, AiColumnNote> | undefined;
  /**
   * The columns the example fits more than one rule for (SPEC 21 v12 item 11): each one whose question is still open (its check is in the rules)
   * is asked on its line in the map. Undefined / empty: no question.
   */
  ambiguous?: readonly AmbiguousColumn[] | undefined;
  name: string;
  onRename?: ((name: string) => void) | undefined;
  learnedNote: string;
  /** After an AI learn: what code filled in the answer from the example, in one quiet line under `learnedNote` (SPEC 21 v12 item 16). */
  filledNote?: string | undefined;
  /** Rows shown on screen (the free tier's 20); `null` = all. */
  previewLimit: number | null;
  onSignIn(): void;
  actions(info: WorkbenchInfo): ReactNode;
  /** Messages between the header and the live check. */
  banners?: ((info: WorkbenchInfo) => ReactNode) | undefined;
  /** Shown in place of the preview when there is no example in memory. */
  noExample?: ReactNode;
  /** What the live counter says when there is no example (default: it is not in memory any more). */
  noExampleText?: string | undefined;
  /** Under the preview and the flags. */
  footer?: ReactNode;
  /** The Upload - Learn - Use line (a fresh learn); not for a saved source or an added one. */
  stepper?: boolean;
  /** Where "This changes the format for all N sources" is said: in the editor panel (default), or only by the caller's banners. */
  formatChangeNote?: 'panel' | 'banner';
  /**
   * "Unsaved changes" next to Save, and a question before leaving the page, while the rules differ from the saved (or learned) ones
   * (default: true). A screen that has already saved and can't save again turns it off.
   */
  trackUnsaved?: boolean;
}

export function Workbench(props: WorkbenchProps) {
  const { t, lang, dir } = useI18n();
  const { engine } = useServices();
  const { store, exampleId, exampleInput, inputFile, tier, format, source, partial, verification, previewLimit, analysing } = props;
  const editor = useEditor(store);
  const rules = editor.state.rules;

  // A column that still has nothing to fill it says so (amber) even after the user touched it: "edited" would hide that.
  const needsInput = useMemo(() => columnsWithoutRule(rules), [rules]);
  // Only the columns something fills are compared with the example: a column whose values are not in the input (or that the AI step still has
  // to work out) would differ on every row, and "N differences" is not what it means - it says "N columns need your input" (SPEC 8.11).
  // Whatever is compared is the same everywhere: the local partial result (SPEC 21 v5 item 1) and a finished result with such a column.
  const partialPending = partial !== undefined && partial.reason === 'aiNotAllowed';
  const onlyColumns = useMemo(() => {
    if (!partialPending && needsInput.size === 0) return undefined;
    const positions: number[] = [];
    rules.output.columns.forEach((c, i) => {
      if (!needsInput.has(c.header)) positions.push(i);
    });
    return positions;
  }, [partialPending, needsInput, rules.output.columns]);

  const unsaved = props.trackUnsaved !== false && editor.state.dirty;

  const check = useLiveCheck({ engine, exampleId, editor: editor.state, tier, ...(format ? { format } : {}), ...(source ? { source } : {}), ...(onlyColumns ? { onlyColumns } : {}) });
  const live = check.state.live;

  // What the last edit did, said on the line it changed for a few seconds.
  const applied = useApplied({ rules, rev: editor.state.rev, check, hasExample: exampleId !== undefined });

  // Where a column's rule doesn't reproduce the example (on its line, and above the preview).
  const mismatches = useMemo(() => columnMismatches(live, rules), [live, rules]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const open = (id: string): void => {
    setSelectedId(id);
    setAdvanced(false);
  };
  const close = (): void => {
    setSelectedId(null);
    setAdvanced(false);
  };

  // The map fills in line by line, once.
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setIntro(false), INTRO_MS);
    return () => clearTimeout(timer);
  }, []);

  // Read-only while the deep analysis works (see `analysing`): the store refuses what would touch it.
  const lock = useMemo<EditLock | null>(
    () => (analysing ? { columns: analysing.columns, parts: new Set(analysing.parts), ...(analysing.whole ? { whole: true } : {}) } : null),
    [analysing],
  );
  useEffect(() => {
    store.setLock(lock);
    return () => store.setLock(null);
  }, [store, lock]);

  // Undo and redo from the keyboard, except inside a field (where the browser's own undo belongs to the text).
  const { undo, redo } = editor;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const model = useMemo(() => {
    const edited = new Set([...editor.state.edited].filter((id) => !(id.startsWith('col:') && needsInput.has(id.slice(4)))));
    return describeRules(rules, { lang, verification: live ?? verification ?? undefined, edited });
  }, [rules, lang, live, verification, editor.state.edited, needsInput]);

  const run = useRunFlags({
    rules,
    rev: editor.state.rev,
    file: inputFile,
    ready: !check.stale && check.state.status === 'ready' && check.problems.length === 0,
  });

  // The example input's columns no rule declares yet are offered by every source dropdown, and an edit that uses one declares it in the same
  // undoable step. Columns the user typed in (a saved source has no example files) are treated the same way; the ref lets an edit made right
  // after typing one see it before the next render.
  const [typed, setTyped] = useState<readonly ExampleInputColumn[]>([]);
  const typedRef = useRef<readonly ExampleInputColumn[]>(typed);
  const available = useMemo<readonly ExampleInputColumn[]>(() => [...(exampleInput ?? []), ...typed], [exampleInput, typed]);
  const applyEdit = useCallback(
    (action: EditAction, options?: ApplyActionOptions) => editor.apply(action, { ...options, available: [...(exampleInput ?? []), ...typedRef.current] }),
    [editor.apply, exampleInput],
  );
  const addInput = useCallback(
    (column: ExampleInputColumn): string => {
      const current = editor.store.getState().rules;
      const key = normalizeHeader(column.header);
      const declared = current.input.columns.find((c) => normalizeHeader(c.header) === key || (c.aliases ?? []).some((a) => normalizeHeader(a) === key));
      if (declared) return declared.id;
      if (!(exampleInput ?? []).some((c) => normalizeHeader(c.header) === key) && !typedRef.current.some((c) => normalizeHeader(c.header) === key)) {
        typedRef.current = [...typedRef.current, column];
        setTyped(typedRef.current);
      }
      const list = [...(exampleInput ?? []), ...typedRef.current];
      return availableInputs(current, list).find((a) => normalizeHeader(a.column.header) === key)?.id ?? '';
    },
    [editor.store, exampleInput],
  );
  const ctx = useMemo<EditorCtx>(
    () => ({
      rules,
      apply: applyEdit,
      rev: editor.state.rev,
      currentRev: () => editor.store.getState().rev,
      language: rules.output.language,
      available,
      canTypeInput: exampleInput === undefined,
      addInput,
    }),
    [rules, applyEdit, editor.state.rev, editor.store, available, exampleInput, addInput],
  );

  // ----- actions -----

  const add = (kind: AddKind): void => {
    const plan = planAdd(rules, kind, { column: t('map.newColumn'), title: t('map.newTitle'), total: t('map.newTotal') });
    if (plan && applyEdit(plan.action).ok) open(plan.lineId);
  };
  // The ambiguity question (SPEC 21 v12 item 11): the check that marks it as unanswered is in the rules while it is open, so deleting that check
  // in the editor closes it too. An answer applies the reading and takes the check out, in one undoable edit. "Not sure yet" only folds the question.
  const [unsure, setUnsure] = useState<ReadonlySet<string>>(new Set());
  const ask = useMemo(() => {
    const open = (props.ambiguous ?? []).filter((c) => questionOpen(rules, c));
    if (open.length === 0) return undefined;
    const answer = (column: AmbiguousColumn, index: number): void => {
      const next = applyReading(editor.store.getState().rules, column, index, false);
      if (next) editor.apply({ type: 'replaceRules', rules: next });
    };
    const fold = (header: string, folded: boolean): void =>
      setUnsure((prev) => {
        const next = new Set(prev);
        if (folded) next.add(header);
        else next.delete(header);
        return next;
      });
    return (header: string): ReactNode => {
      const column = open.find((c) => c.header === header);
      if (!column) return null;
      return (
        <ReadingQuestion
          column={column}
          rules={rules}
          unsure={unsure.has(header)}
          disabled={lock !== null}
          onAnswer={(index) => answer(column, index)}
          onUnsure={() => fold(header, true)}
          onReopen={() => fold(header, false)}
        />
      );
    };
  }, [props.ambiguous, rules, unsure, lock, editor]);
  const keep = (line: Line): void => {
    // From the last to the first, so the indexes still mean what they meant.
    for (const index of assumptionIndexes(rules, line).reverse()) editor.apply({ type: 'dismissAssumption', index });
  };
  const reorder = (from: number, to: number): void => void editor.apply({ type: 'reorderColumns', from, to });

  // ----- the columns and parts that still need the AI step (SPEC 21 v5 item 1) -----

  const aiStep = useMemo(() => {
    const pending = partial !== undefined && partial.reason === 'aiNotAllowed' ? partial : undefined;
    if (!pending && !analysing) return undefined;
    // A column the user has filled in since is no longer waiting for the AI step, and neither is a layout part they have built.
    const stillEmpty = (h: string): boolean => rules.output.columns.some((c) => c.header === h && c.from === null);
    const columns = new Set((pending?.needsAi ?? []).filter(stillEmpty));
    const external = new Set((pending?.external ?? []).filter(stillEmpty));
    const parts: AiStepPartCode[] = pending ? missingParts(rules, pending.needsAiParts) : [];
    if (!analysing) return { columns, external, parts };
    const running = { columns: new Set([...analysing.columns].filter(stillEmpty)), parts: missingParts(rules, analysing.parts) };
    for (const h of running.columns) columns.add(h);
    for (const code of running.parts) if (!parts.includes(code)) parts.push(code);
    return { columns, external, parts, running };
  }, [partial, analysing, rules]);
  // An "Add ..." button whose edit the deep analysis is working on is not offered meanwhile.
  const addLocked = useMemo(() => {
    if (!lock) return undefined;
    return (kind: AddKind): boolean => {
      const plan = planAdd(rules, kind, { column: '', title: '', total: '' });
      return plan ? lockProblem(plan.action, rules, lock) !== null : false;
    };
  }, [lock, rules]);

  // ----- the badge -----

  const status = check.saveStatus;
  const differences = differencesOf(status);
  let badge: { tone: 'verified' | 'check' | 'neutral'; text: string; busy?: boolean };
  // Rules that can't be saved come first; then what still needs the AI step; then columns that need the user; then how well the rows match.
  if (status.kind === 'blocked') badge = { tone: 'check', text: t(status.problems.length === 1 ? 'result.badge.blocked.one' : 'result.badge.blocked.other', { n: status.problems.length }) };
  else if (aiStep && aiStep.columns.size > 0) badge = { tone: 'check', text: t(aiStep.columns.size === 1 ? 'partial.badge.one' : 'partial.badge.other', { n: aiStep.columns.size }) };
  else if (aiStep && aiStep.parts.length > 0) badge = { tone: 'check', text: t('partial.badge.parts') };
  else if (needsInput.size > 0) badge = { tone: 'check', text: t(needsInput.size === 1 ? 'result.badge.needsInput.one' : 'result.badge.needsInput.other', { n: needsInput.size }) };
  else if (status.kind === 'needsInput') badge = { tone: 'check', text: t(status.columns === 1 ? 'result.badge.needsInput.one' : 'result.badge.needsInput.other', { n: status.columns }) };
  else if (status.kind === 'verified') badge = { tone: 'verified', text: t('result.badge.verified') };
  else if (status.kind === 'differences') badge = { tone: 'check', text: t(status.differences === 1 ? 'result.badge.differences.one' : 'result.badge.differences.other', { n: status.differences }) };
  else if (status.kind === 'checkFailed') badge = { tone: 'check', text: t('result.badge.checkFailed') };
  else if (status.kind === 'noExample') badge = { tone: 'neutral', text: t('result.badge.noExample') };
  else badge = { tone: 'neutral', text: t('result.badge.checking'), busy: true };

  const info: WorkbenchInfo = {
    rules,
    exceptions: editor.state.exceptions,
    status,
    metaStatus: metaStatusOf(status),
    differences,
    live,
    needsInput,
    dirty: editor.state.dirty,
    formatChange: editor.state.formatChange,
    sourceCount: editor.state.format?.sourceCount ?? 1,
    sourceChange: editor.state.sourceChange,
    sourceFormats: editor.state.source?.formats ?? 1,
    editor,
    check,
    openLine: open,
  };

  const panelOpen = advanced || selectedId !== null;
  const noExample = exampleId === undefined;

  return (
    <main id="main" className="page page--result" tabIndex={-1}>
      <LeaveGuard when={unsaved} check={() => editor.store.getState().dirty} />
      <section className="tool result">
        {props.stepper ? <Stepper current={3} /> : null}
        <div className="view result__view">
          <ResultHeader
            name={props.name}
            onRename={props.onRename}
            badge={<StatusBadge tone={badge.tone} text={badge.text} {...(badge.busy ? { busy: true } : {})} />}
            learnedNote={props.learnedNote}
            filledNote={props.filledNote}
            canUndo={editor.canUndo && !lock}
            canRedo={editor.canRedo && !lock}
            onUndo={editor.undo}
            onRedo={editor.redo}
            unsaved={unsaved}
            actions={props.actions(info)}
          />

          {props.banners?.(info)}

          <LiveCheckStrip check={check} noExampleText={props.noExampleText} />

          <div className="workbench">
            <div className="workbench__map">
              <RulesMap
                model={model}
                rules={rules}
                selectedId={selectedId}
                columnChecks={live?.perColumn}
                mismatches={mismatches}
                intro={intro}
                onSelect={(line) => open(line.id)}
                onKeep={keep}
                onReorder={reorder}
                onAdd={add}
                aiStep={aiStep}
                addLocked={addLocked}
                noExample={noExample}
                applied={applied}
                aiNotes={props.aiNotes}
                ask={ask}
              />
              <p className="workbench__advanced">
                <Button
                  variant="link"
                  onClick={() => {
                    setSelectedId(null);
                    setAdvanced(true);
                  }}
                >
                  {t('editor.advanced.open')}
                </Button>
              </p>
            </div>
            <div className="workbench__panel" data-open={panelOpen || undefined}>
              {panelOpen ? (
                <EditorPanel
                  ctx={ctx}
                  model={model}
                  selectedId={selectedId}
                  advanced={advanced}
                  live={live}
                  formatChange={editor.state.formatChange && props.formatChangeNote !== 'banner'}
                  sourceCount={editor.state.format?.sourceCount ?? 1}
                  onClose={close}
                  onOpen={open}
                  onAdvanced={(on) => {
                    setAdvanced(on);
                    if (on) setSelectedId(null);
                  }}
                  onRenamed={(header) => setSelectedId(lineIds.col(header))}
                  onMoveColumn={reorder}
                />
              ) : (
                <EditorEmpty
                  onAdvanced={() => {
                    setSelectedId(null);
                    setAdvanced(true);
                  }}
                />
              )}
            </div>
          </div>

          {noExample && props.noExample ? (
            props.noExample
          ) : (
            <PreviewGrid
              live={live}
              rules={rules}
              flags={run.flags}
              limit={previewLimit}
              uiDir={dir}
              onFixRule={(header) => open(lineIds.col(header))}
              onSignIn={props.onSignIn}
            />
          )}

          <FlagsList flags={run.flags} summary={run.summary} rules={rules} limit={previewLimit} onSignIn={props.onSignIn} />

          {props.footer}
        </div>
      </section>
    </main>
  );
}
