// The Result screen (SPEC 16.1 screen 4, 8.11): the rules map, its editor, the live check and the preview grid.
import { tiers, type Tier } from '@formatai/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLearnSession } from '../../app/LearnSession';
import { useSignIn } from '../../app/SignIn';
import { lineIds, useEditor, useLiveCheck } from '../../editor';
import type { UseLearnFlow } from '../../flow/useLearnFlow';
import { useI18n } from '../../i18n';
import { describeRules, type Line } from '../../rulesText';
import { useServices } from '../../services';
import { Button, Stepper } from '../../ui';
import type { LearnOutput } from '../../worker/engineApi';
import { EditorEmpty, EditorPanel } from './EditorPanel';
import type { EditorCtx } from './fields';
import { FlagsList } from './FlagsList';
import { assumptionIndexes, planAdd, type AddKind } from './helpers';
import { LiveCheckStrip } from './LiveCheckStrip';
import { PreviewGrid } from './PreviewGrid';
import { ResultHeader, StatusBadge } from './ResultHeader';
import { RulesMap } from './RulesMap';
import { defaultFormatName, getResultSession } from './session';
import { useRunFlags } from './useRunFlags';

/** The props are exactly what `useLearnFlow` returns: `state` (status 'done' here), and the flow's actions. */
export type ResultPageProps = UseLearnFlow;

/** M2 has no accounts yet (sign-in arrives in M3): every visitor is on the free tier. */
const TIER: Tier = 'anonymous';

/** How long the map takes to fill in line by line after learning (the screen's one orchestrated motion). */
const INTRO_MS = 1800;

export function ResultPage({ state }: ResultPageProps) {
  if (state.status !== 'done' || !state.result.rules) return null;
  return <ResultScreen result={state.result} />;
}

function ResultScreen({ result }: { result: LearnOutput }) {
  const { t, lang, dir } = useI18n();
  const { engine } = useServices();
  const session = useLearnSession();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const limits = tiers[TIER];

  // The edits (and the name) live in the session, not in this component: they survive leaving the screen and the sign-in wall.
  const saved = getResultSession(result, defaultFormatName(session.output?.name, t('result.untitled')));
  const [name, setName] = useState(saved.name);
  const editor = useEditor(saved.store);
  const rules = editor.state.rules;
  const check = useLiveCheck({ engine, exampleId: result.exampleId, editor: editor.state, tier: TIER });
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
    return describeRules(rules, { lang, verification: live ?? result.verification ?? undefined, edited });
  }, [rules, lang, live, result.verification, editor.state.edited, needsInput]);

  const run = useRunFlags({
    rules,
    rev: editor.state.rev,
    file: session.input,
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

  // ----- the badge -----

  const status = check.saveStatus;
  let badge: { tone: 'verified' | 'check' | 'neutral'; text: string; busy?: boolean };
  // Rules that can't be saved come first; then columns that need the user; then how well the rows match.
  if (status.kind === 'blocked') badge = { tone: 'check', text: t(status.problems.length === 1 ? 'result.badge.blocked.one' : 'result.badge.blocked.other', { n: status.problems.length }) };
  else if (needsInput.size > 0) badge = { tone: 'check', text: t(needsInput.size === 1 ? 'result.badge.needsInput.one' : 'result.badge.needsInput.other', { n: needsInput.size }) };
  else if (status.kind === 'verified') badge = { tone: 'verified', text: t('result.badge.verified') };
  else if (status.kind === 'differences') badge = { tone: 'check', text: t(status.differences === 1 ? 'result.badge.differences.one' : 'result.badge.differences.other', { n: status.differences }) };
  else if (status.kind === 'checkFailed') badge = { tone: 'check', text: t('result.badge.checkFailed') };
  else if (status.kind === 'noExample') badge = { tone: 'neutral', text: t('result.badge.noExample') };
  else badge = { tone: 'neutral', text: t('result.badge.checking'), busy: true };

  const panelOpen = advanced || selectedId !== null;

  return (
    <main id="main" className="page page--result" tabIndex={-1}>
      <section className="tool result">
        <Stepper current={3} />
        <div className="view result__view">
          <ResultHeader
            name={name}
            onRename={(next) => {
              setName(next);
              saved.name = next;
            }}
            badge={<StatusBadge tone={badge.tone} text={badge.text} {...(badge.busy ? { busy: true } : {})} />}
            learnedNote={t(result.path === 'local' ? 'flow.path.local' : 'flow.path.llm')}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onUndo={editor.undo}
            onRedo={editor.redo}
            // Saving and downloading need an account (SPEC 11, 5 E); the rules stay in this session while the wall is open.
            onSave={() => signIn.open('save')}
            saveDisabled={status.kind === 'blocked'}
            hint={limits.fullDownload ? undefined : t('result.freeHint', { n: limits.previewRows ?? 0 })}
          />

          <LiveCheckStrip check={check} />

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
                  formatChange={editor.state.formatChange}
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

          <PreviewGrid
            live={live}
            rules={rules}
            flags={run.flags}
            limit={limits.previewRows}
            exceptions={editor.state.exceptions}
            uiDir={dir}
            onException={(row) => void editor.apply({ type: 'markException', row })}
            onUnexception={(row) => void editor.apply({ type: 'unmarkException', row })}
            onSignIn={() => signIn.open('save')}
          />

          <FlagsList flags={run.flags} summary={run.summary} rules={rules} limit={limits.previewRows} onSignIn={() => signIn.open('save')} />

          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                session.startOver();
                navigate('/');
              }}
            >
              {t('result.startOver')}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

export default ResultPage;
