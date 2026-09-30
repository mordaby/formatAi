// The working part of the Result screen (SPEC 8.11, 16.1 screen 4): the header, the live check, the rules map with its editor, the
// preview grid and the flagged rows. It does not know where the rules came from - a fresh learn, a source being added to a
// format, or a saved source opened for editing - or what "save" means there: the caller passes the header's actions, banners
// and (when there is no example in memory) what replaces the preview.
import type { AiStepPartCode, Format, Tier } from '@formatai/shared';
import type { PartialInfo } from '@formatai/engine';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { lineIds, useEditor, useLiveCheck, metaStatusOf, differencesOf, type EditableRules, type EditorStore, type SaveStatus, type UseEditor, type UseLiveCheck } from '../../editor';
import { useI18n } from '../../i18n';
import { describeRules, type Line, type VerificationLike } from '../../rulesText';
import { useServices } from '../../services';
import { Button, Stepper } from '../../ui';
import type { LiveCheckResult } from '../../worker/editorApi';
import { EditorEmpty, EditorPanel } from './EditorPanel';
import type { EditorCtx } from './fields';
import { FlagsList } from './FlagsList';
import { assumptionIndexes, planAdd, type AddKind } from './helpers';
import { LiveCheckStrip } from './LiveCheckStrip';
import { PreviewGrid } from './PreviewGrid';
import { ResultHeader, StatusBadge } from './ResultHeader';
import { RulesMap } from './RulesMap';
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
  editor: UseEditor;
  check: UseLiveCheck;
}

export interface WorkbenchProps {
  /** The edits and their undo history live outside the component, so they survive leaving the screen and the sign-in wall. */
  store: EditorStore;
  /** Undefined: no example is in memory; only the static checks run. */
  exampleId: string | undefined;
  /** The example INPUT file, for the flagged rows a real run would give. */
  inputFile: File | null;
  tier: Tier;
  /** Inside a format: turns on the format lock (SPEC 8.12). */
  format?: Format | undefined;
  /** SPEC 21 v5 item 1: the local partial result (columns the AI step still has to work out are marked, and only the built ones are checked). */
  partial?: PartialInfo | undefined;
  /** The learn's own verification, shown in the map until the live check answers. */
  verification?: VerificationLike | null | undefined;
  name: string;
  onRename?: ((name: string) => void) | undefined;
  learnedNote: string;
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
}

export function Workbench(props: WorkbenchProps) {
  const { t, lang, dir } = useI18n();
  const { engine } = useServices();
  const { store, exampleId, inputFile, tier, format, partial, verification, previewLimit } = props;
  const editor = useEditor(store);
  const rules = editor.state.rules;

  // SPEC 21 v5 item 1: only the columns code built are compared in the local partial result. Positions follow the current rules.
  const solved = partial && partial.reason === 'aiNotAllowed' ? partial.solved : undefined;
  const onlyColumns = useMemo(() => {
    if (!solved) return undefined;
    const set = new Set(solved);
    const positions: number[] = [];
    rules.output.columns.forEach((c, i) => {
      if (set.has(c.header)) positions.push(i);
    });
    return positions;
  }, [solved, rules.output.columns]);

  const check = useLiveCheck({ engine, exampleId, editor: editor.state, tier, ...(format ? { format } : {}), ...(onlyColumns ? { onlyColumns } : {}) });
  const live = check.state.live;

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

  // A column that still has nothing to fill it says so (amber) even after the user touched it: "edited" would hide that.
  const needsInput = useMemo(() => {
    const headers = new Set<string>();
    for (const c of rules.output.columns) if (c.from === null) headers.add(c.header);
    for (const u of rules.unsupported) if (rules.output.columns.some((c) => c.header === u.outputColumn)) headers.add(u.outputColumn);
    return headers;
  }, [rules]);
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

  const ctx = useMemo<EditorCtx>(
    () => ({ rules, apply: editor.apply, rev: editor.state.rev, currentRev: () => editor.store.getState().rev, language: rules.output.language }),
    [rules, editor.apply, editor.state.rev, editor.store],
  );

  // ----- actions -----

  const add = (kind: AddKind): void => {
    const plan = planAdd(rules, kind, { column: t('map.newColumn'), title: t('map.newTitle'), total: t('map.newTotal') });
    if (plan && editor.apply(plan.action).ok) open(plan.lineId);
  };
  const keep = (line: Line): void => {
    // From the last to the first, so the indexes still mean what they meant.
    for (const index of assumptionIndexes(rules, line).reverse()) editor.apply({ type: 'dismissAssumption', index });
  };
  const reorder = (from: number, to: number): void => void editor.apply({ type: 'reorderColumns', from, to });

  // ----- the columns and parts that still need the AI step (SPEC 21 v5 item 1) -----

  const aiStep = useMemo(() => {
    if (!partial || partial.reason !== 'aiNotAllowed') return undefined;
    // A column the user has filled in since is no longer waiting for the AI step.
    const columns = new Set(partial.needsAi.filter((h) => rules.output.columns.some((c) => c.header === h && c.from === null)));
    const parts: AiStepPartCode[] = [...partial.needsAiParts];
    return { columns, parts };
  }, [partial, rules.output.columns]);

  // ----- the badge -----

  const status = check.saveStatus;
  const differences = differencesOf(status);
  let badge: { tone: 'verified' | 'check' | 'neutral'; text: string; busy?: boolean };
  // Rules that can't be saved come first; then what still needs the AI step; then columns that need the user; then how well the rows match.
  if (status.kind === 'blocked') badge = { tone: 'check', text: t(status.problems.length === 1 ? 'result.badge.blocked.one' : 'result.badge.blocked.other', { n: status.problems.length }) };
  else if (aiStep && aiStep.columns.size > 0) badge = { tone: 'check', text: t(aiStep.columns.size === 1 ? 'partial.badge.one' : 'partial.badge.other', { n: aiStep.columns.size }) };
  else if (aiStep && aiStep.parts.length > 0) badge = { tone: 'check', text: t('partial.badge.parts') };
  else if (needsInput.size > 0) badge = { tone: 'check', text: t(needsInput.size === 1 ? 'result.badge.needsInput.one' : 'result.badge.needsInput.other', { n: needsInput.size }) };
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
    editor,
    check,
  };

  const panelOpen = advanced || selectedId !== null;
  const noExample = exampleId === undefined;

  return (
    <main id="main" className="page page--result" tabIndex={-1}>
      <section className="tool result">
        {props.stepper ? <Stepper current={3} /> : null}
        <div className="view result__view">
          <ResultHeader
            name={props.name}
            onRename={props.onRename}
            badge={<StatusBadge tone={badge.tone} text={badge.text} {...(badge.busy ? { busy: true } : {})} />}
            learnedNote={props.learnedNote}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onUndo={editor.undo}
            onRedo={editor.redo}
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
                intro={intro}
                onSelect={(line) => open(line.id)}
                onKeep={keep}
                onReorder={reorder}
                onAdd={add}
                aiStep={aiStep}
                noExample={noExample}
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
              exceptions={editor.state.exceptions}
              uiDir={dir}
              onException={(row) => void editor.apply({ type: 'markException', row })}
              onUnexception={(row) => void editor.apply({ type: 'unmarkException', row })}
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
