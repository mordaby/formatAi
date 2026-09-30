import { blockView } from '../app/messages';
import { Cell } from '../components/Cell';
import type { LearnFlowState } from '../flow/learnFlow';
import { useI18n } from '../i18n';
import { Button, InlineMessage } from '../ui';

type PreflightState = Extract<LearnFlowState, { status: 'warn' | 'blocked' }>;

export interface LearningPreflightProps {
  state: PreflightState;
  /** Go ahead past a warning: "Continue" (leave unknown columns empty) or "Try anyway". */
  onConfirm(): void;
  /** Stop and go back to the files. */
  onCancel(): void;
  /** Offered when signing in would lift the limit that blocked the files. */
  onSignIn(): void;
}

/**
 * SPEC 16.1 screen 2: shown only when there is a warning or a block. It says what was found, in
 * words, and what the user can do. A block costs nothing and never calls the server.
 */
export function LearningPreflight({ state, onConfirm, onCancel, onSignIn }: LearningPreflightProps) {
  const i18n = useI18n();
  const { t, code } = i18n;

  if (state.status === 'blocked') {
    const views = state.result.preflight.issues.filter((i) => i.severity === 'block').map((issue) => ({ issue, view: blockView(i18n, issue) }));
    const offerSignIn = views.some((v) => v.view.offerSignIn);
    return (
      <div className="view preflight">
        <header className="tool__head">
          <h1>{t('flow.blocked')}</h1>
        </header>
        <div className="preflight__list">
          {views.map(({ issue, view }, n) => (
            <InlineMessage key={`${issue.code}-${n}`} tone="block" {...(view.todo ? { todo: view.todo } : {})}>
              {view.text}
            </InlineMessage>
          ))}
        </div>
        <div className="preflight__actions">
          <Button variant="primary" onClick={onCancel}>
            {t('preflight.changeFiles')}
          </Button>
          {offerSignIn && (
            <Button variant="secondary" onClick={onSignIn}>
              {t('header.signIn')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const tryAnyway = state.reason === 'tryAnyway';
  return (
    <div className="view preflight">
      <header className="tool__head">
        <h1>{t('preflight.warnTitle')}</h1>
      </header>
      <div className="preflight__list">
        {state.issues.map((issue, n) => (
          <InlineMessage key={`${issue.code}-${n}`} tone="warn" {...(tryAnyway ? { todo: t('preflight.tryAnywayNote') } : {})}>
            <p>{code({ kind: 'preflight', code: issue.code, ...(issue.params ? { params: issue.params } : {}) })}</p>
            {state.columns.length > 0 && (
              <div className="chips-block">
                <p className="chips-block__lead">{t('preflight.columnsLead')}</p>
                <ul className="chips">
                  {state.columns.map((column, i) => (
                    <li key={`${i}-${column}`}>
                      <Cell value={column} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </InlineMessage>
        ))}
      </div>
      <div className="preflight__actions">
        <Button variant="primary" onClick={onConfirm}>
          {t(tryAnyway ? 'flow.warn.tryAnyway' : 'flow.warn.continue')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('flow.cancel')}
        </Button>
      </div>
    </div>
  );
}
