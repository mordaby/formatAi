// The one place for the AI step on the Result screen (owner decision: the AI step never runs unless the user chooses it).
// The free engine has already run: this panel says what it solved, lists what it could not (output fields, and the layout parts it could
// not build) with a tick each, and offers the one action "Finish with AI" - or, for a visitor, the sign-in prompt. The one button
// completes the ticked fields when it can and runs the whole learn when it can't (`runDeep` in the Result screen: there is no second AI button).
// While it runs the panel shows the progress; afterwards what the AI solved and what still needs the user's input (an honest "could not
// produce" stays "needs your input").
// It also carries "See what we send" (SPEC 15) for the call it made, and the plain-words reasons a run was not used.
import { aiReadinessMessages, aiStepPartMessages, type AiColumnNote, type AiLearnQuotaState, type AiStepPartCode } from '@formatai/shared';
import { useId, useState, type ReactNode } from 'react';
import { aiUsesLabel, includedLabel } from '../../app/aiQuota';
import { errorView } from '../../app/messages';
import { useLearnSession } from '../../app/LearnSession';
import { SendPanel } from '../../app/SendPanel';
import { Cell } from '../../components/Cell';
import { localize, useI18n } from '../../i18n';
import { Button, Icon, Spinner } from '../../ui';
import { roundText } from '../learningSteps';
import type { UseCompletion } from './useCompletion';

/** An output field with no rule yet. */
export interface MissingColumn {
  /** Position in the output columns (what the completion request is asked for). */
  index: number;
  header: string;
  /** Code found no trace of its values in the input file: it may come from another source (the AI step still tries it). */
  external: boolean;
}

/** The key a tick is kept under: the header is part of it, so a column that moved or was renamed is simply ticked again. */
export const columnKey = (c: Pick<MissingColumn, 'index' | 'header'>): string => `col:${c.index}:${c.header}`;
export const partKey = (code: AiStepPartCode): string => `part:${code}`;

export interface DeepAnalysisPanelProps {
  /** The free engine's own result (nothing from the AI step yet). Otherwise the title says how many fields are solved, without crediting the free engine. */
  free: boolean;
  /** How many output fields there are. */
  total: number;
  /** What has no rule yet, and the layout parts the rules still lack. */
  columns: readonly MissingColumn[];
  parts: readonly AiStepPartCode[];
  /** `checking`: `/api/me` has not answered yet. */
  who: 'checking' | 'guest' | 'user';
  /** What is left of the AI formats (null: not known yet). */
  quota: AiLearnQuotaState | null;
  completion: UseCompletion;
  /**
   * learn-v7: what the AI step noted about the fields it could not build, by header: its guess at the rule ("The AI's guess (not applied)": in
   * this session only, never saved) and whether a function request was recorded. Said under the field, next to the way to fill it in yourself.
   */
  aiNotes?: ReadonlyMap<string, AiColumnNote> | undefined;
  /** Ticks the user removed (`columnKey` / `partKey`); everything else is ticked. */
  unticked: ReadonlySet<string>;
  onToggle(key: string, ticked: boolean): void;
  /** A whole learn will run (too little solved for a completion): the choice is fixed, all ticked. */
  whole: boolean;
  /** The run is the way forward (the result can't be saved without it): the primary button; otherwise a secondary one. */
  primary: boolean;
  onRun(): void;
  onSignIn(): void;
  /** "Download with these fields empty": the converted example, right away (a visitor is asked to sign in instead). */
  onDownload(): void;
  downloading: boolean;
}

export function DeepAnalysisPanel(p: DeepAnalysisPanelProps) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const session = useLearnSession();
  const sent = session.completion.state.sent;
  const [sendOpen, setSendOpen] = useState(false);
  const sendId = useId();
  const titleId = useId();
  const { completion } = p;
  const { running, outcome, exhausted } = completion;

  const listed = p.columns.length + p.parts.length;
  const solved = p.total - p.columns.length;
  const done = !running && outcome?.kind === 'done';
  const failed = !running && outcome !== null && outcome.kind !== 'done';
  const ticked = p.whole ? listed : p.columns.filter((c) => !p.unticked.has(columnKey(c))).length + p.parts.filter((c) => !p.unticked.has(partKey(c))).length;
  const noneLeft = p.quota !== null && p.quota.remaining === 0;
  const canRun = p.who === 'user' && !running && !exhausted && !noneLeft && (listed === 0 || ticked > 0);
  // Fields that still have no rule once the AI step has been tried (or cannot be, for now) are final for now: said honestly (never as an error),
  // and delivered anyway - the file can be downloaded with them empty, filled in by hand, or the format saved with them as "needs your input".
  const leftover = p.columns.length > 0;
  const final = leftover && !running && (!p.free || (p.who === 'user' && (noneLeft || exhausted)));

  // ----- what the last run came to -----
  const notice = ((): ReactNode => {
    if (running || !outcome) return null;
    if (outcome.kind === 'done') {
      const { asked, produced } = outcome;
      return (
        <div className="deep__notice" role="status">
          <p data-testid="completion-done">
            <Icon name="check" size={16} /> {t('deep.done')}
          </p>
          {asked.columns > 0 ? <p>{t('deep.done.count', { n: produced.columns, asked: asked.columns })}</p> : null}
          {outcome.merged ? <p className="muted">{t('deep.done.merged')}</p> : null}
        </div>
      );
    }
    if (outcome.kind === 'kept') {
      const text =
        outcome.why === 'lock'
          ? t('complete.kept.lock')
          : outcome.why === 'mismatch'
            ? t('complete.kept.mismatch')
            : outcome.why === 'nothing'
              ? t('complete.kept.nothing')
              : t('complete.kept.changed');
      return (
        <div className="deep__notice" role="status">
          <p className="deep__notice-title">{t('complete.kept.title')}</p>
          <p data-testid="completion-kept">{text}</p>
          <p className="muted">{t('complete.kept.todo')}</p>
        </div>
      );
    }
    if (outcome.kind === 'notReady') {
      const readiness = outcome.result.readiness;
      const issues = readiness && !readiness.ready ? readiness.issues : [];
      return (
        <div className="deep__notice" role="alert">
          <p className="deep__notice-title">{t('notReady.title')}</p>
          {issues.map((issue, n) => (
            <p key={`${issue.code}-${n}`} data-testid="completion-notready">
              {localize(lang, aiReadinessMessages[issue.code], issue.params)}
            </p>
          ))}
          <p className="muted">{t('notReady.nothingUsed')}</p>
        </div>
      );
    }
    const view = errorView(i18n, outcome.error);
    return (
      <div className="deep__notice" role="alert">
        <p className="deep__notice-title">{t('complete.kept.title')}</p>
        <p data-testid="completion-error">{view.text}</p>
        {view.todo ? <p className="muted">{view.todo}</p> : null}
      </div>
    );
  })();

  // ----- the fields -----
  const fieldText = (header: string, external: boolean): ReactNode => (
    <span>
      <Cell value={header} />
      {external ? <span className="muted"> — {t('deep.external')}</span> : null}
    </span>
  );
  const partText = (code: AiStepPartCode): ReactNode => <span>{localize(lang, aiStepPartMessages[code])}</span>;
  // The AI step can be asked (again): the user ticks what it should work on. After an answer it has just given there is nothing to ask again.
  const retryable = p.who === 'user' && !done && !exhausted && !noneLeft;
  const choosing = retryable && !running && listed > 0;
  const showRun = p.who === 'user' && !done && !(final && !retryable);
  const noteOf = (header: string | undefined): ReactNode => {
    const note = header === undefined || running ? undefined : p.aiNotes?.get(header);
    if (!note || (!note.explanation && !note.functionRecorded)) return null;
    return (
      <div className="deep__guess" data-testid="deep-guess">
        {note.explanation ? (
          <p>
            <span className="deep__guess-label">{t('ai.guess.label')}</span> <bdi>{note.explanation}</bdi>
          </p>
        ) : null}
        {note.functionRecorded ? <p className="muted">{t('ai.functionRecorded')}</p> : null}
      </div>
    );
  };
  const row = (key: string, field: string, text: ReactNode, header?: string): ReactNode => (
    <li key={key} data-field={field}>
      {choosing ? (
        <label className="deep__field">
          <input type="checkbox" className="check__box" checked={p.whole || !p.unticked.has(key)} disabled={p.whole} onChange={(e) => p.onToggle(key, e.target.checked)} />
          {text}
        </label>
      ) : (
        <span className="deep__field">
          <Icon name="alert" size={16} />
          {text}
        </span>
      )}
      {noteOf(header)}
    </li>
  );
  const list = (
    <ul className="deep__fields" data-testid="deep-fields">
      {p.columns.map((c) => row(columnKey(c), `col:${c.header}`, fieldText(c.header, c.external), c.header))}
      {p.parts.map((code) => row(partKey(code), `part:${code}`, partText(code)))}
    </ul>
  );
  const fields =
    listed === 0 || running ? null : final ? (
      <div className="deep__best" data-testid="deep-best">
        <p className="deep__lead">{t(p.columns.length === 1 ? 'deep.best.one' : 'deep.best.other', { n: p.columns.length })}</p>
        {list}
        {choosing && p.whole ? <p className="deep__note">{t('deep.whole')}</p> : null}
      </div>
    ) : (
      <div className="deep__list">
        <p className="deep__lead">{choosing ? t('deep.choose') : t('deep.missing')}</p>
        {list}
        {choosing && p.whole ? <p className="deep__note">{t('deep.whole')}</p> : null}
      </div>
    );
  // The way out with what is solved so far, whatever else happens: download it as it is (a visitor signs in first).
  const deliver =
    leftover && !running && p.who !== 'checking' ? (
      <div className="deep__deliver" data-testid="deep-deliver">
        <p className="deep__note">{t(p.who === 'guest' ? 'deep.deliver.guest' : 'deep.deliver')}</p>
        <div className="deep__actions">
          <Button variant="secondary" loading={p.downloading} disabled={p.downloading} onClick={p.onDownload}>
            {t('deep.download')}
          </Button>
        </div>
      </div>
    ) : null;

  // ----- the quota, in the words of its period -----
  const uses = aiUsesLabel(t, p.quota);

  const state = running ? 'running' : final ? 'final' : done ? 'done' : failed ? 'failed' : p.who === 'user' ? 'offer' : 'signIn';
  return (
    <section className="deep" aria-labelledby={titleId} data-testid="deep-panel" data-state={state} data-tone={failed && !final ? 'warn' : 'info'}>
      <h2 className="deep__title" id={titleId}>
        {p.free ? t('deep.title.free', { solved, total: p.total }) : t('deep.title', { solved, total: p.total })}
      </h2>

      {running ? (
        <div role="status">
          <p className="deep__running" data-testid="completion-running">
            <Spinner size={14} /> {t('deep.running')}
          </p>
          {completion.columnsAsked > 0 ? <p className="muted">{t(completion.columnsAsked === 1 ? 'deep.running.fields.one' : 'deep.running.fields.other', { n: completion.columnsAsked })}</p> : null}
          {completion.round ? (
            <p className="muted" data-testid="completion-round">
              {roundText(t, completion.round)}
            </p>
          ) : null}
          <p className="deep__note">{t('deep.running.note')}</p>
        </div>
      ) : null}

      {notice}
      {fields}
      {final ? deliver : null}

      {listed === 0 && p.who === 'user' && !running && !done ? <p>{t('deep.nothing')}</p> : null}
      {done && listed === 0 ? <p>{t('deep.allSolved')}</p> : null}
      {p.who === 'guest' ? <p>{t('deep.guest', { included: includedLabel(t) })}</p> : null}

      {p.who !== 'user' || showRun ? (
        <div className="deep__actions">
          {p.who === 'checking' ? (
            <Button variant="primary" loading disabled>
              {t('partial.checking')}
            </Button>
          ) : p.who === 'guest' ? (
            <Button variant="primary" onClick={p.onSignIn}>
              {t('partial.banner.signIn')}
            </Button>
          ) : (
            <Button variant={p.primary ? 'primary' : 'secondary'} loading={running} disabled={!canRun} onClick={p.onRun}>
              {t('deep.run')}
            </Button>
          )}
        </div>
      ) : null}

      {p.who === 'user' && !running && !done && (noneLeft || showRun) ? (
        noneLeft ? (
          <p className="deep__note">
            {t('aiLimit.title')}. {t('aiLimit.local')}
          </p>
        ) : (
          <p className="deep__note tabular" data-testid="deep-uses">
            {uses}
          </p>
        )
      ) : null}

      {final ? null : deliver}

      {sent.length > 0 && (
        <p className="privacy__line">
          <Button variant="link" aria-expanded={sendOpen} aria-controls={sendOpen ? sendId : undefined} onClick={() => setSendOpen((o) => !o)}>
            {t('sendPanel.title')}
          </Button>
        </p>
      )}
      {sendOpen && sent.length > 0 && <SendPanel id={sendId} sent={sent} masking={session.masking} onClose={() => setSendOpen(false)} />}
    </section>
  );
}
