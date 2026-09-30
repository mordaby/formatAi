import { useNavigate } from 'react-router-dom';
import { useLearnSession } from '../app/LearnSession';
import type { UseLearnFlow } from '../flow/useLearnFlow';
import { useI18n } from '../i18n';
import { Badge, Button, Stepper } from '../ui';

/** The props are exactly what `useLearnFlow` returns: `state` (status 'done' here), and the flow's actions. */
export type ResultPlaceholderProps = UseLearnFlow;

/**
 * PLACEHOLDER for the Result screen (SPEC 16.1 screen 4), which a later change builds. Swap this
 * component for the real one in app/App.tsx (`ResultRoute`); it gets the learn flow as props, and
 * the example files and masking choice are available from `useLearnSession()`.
 */
export function ResultPlaceholder({ state }: ResultPlaceholderProps) {
  const { t } = useI18n();
  const session = useLearnSession();
  const navigate = useNavigate();
  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">
        <Stepper current={3} />
        <div className="view">
          <header className="tool__head">
            <h1>{t('result.placeholder')}</h1>
            {state.status === 'done' && (
              <p className="lead">
                <Badge tone={state.result.verification?.verified ? 'verified' : 'check'}>
                  {t(state.result.verification?.verified ? 'flow.status.verified' : 'flow.status.notVerified')}
                </Badge>{' '}
                {t(state.result.path === 'local' ? 'flow.path.local' : 'flow.path.llm')}
              </p>
            )}
          </header>
          <div className="learn-row">
            <Button
              variant="secondary"
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
