import { errorView } from '../app/messages';
import type { FlowError } from '../flow/errors';
import { useI18n } from '../i18n';
import { UpgradeButton } from '../app/Upgrade';
import { Button, InlineMessage } from '../ui';

export interface LearningErrorProps {
  error: FlowError;
  onRetry(): void;
  onChangeFiles(): void;
  onSignIn(): void;
}

/**
 * A learn that stopped: a friendly he/en reason and the one thing to try next. "Sign in to keep
 * going" for the anonymous limits; a refresh for a failed anti-bot check; "Try again" for trouble
 * that may pass. Files are kept, so nothing has to be chosen again.
 */
export function LearningError({ error, onRetry, onChangeFiles, onSignIn }: LearningErrorProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const view = errorView(i18n, error);

  return (
    <div className="view preflight">
      <header className="tool__head">
        <h1>{t('learning.title')}</h1>
      </header>
      <InlineMessage tone={view.tone} {...(view.title ? { title: view.title } : {})} {...(view.todo ? { todo: view.todo } : {})}>
        {view.text}
      </InlineMessage>
      <div className="preflight__actions">
        {view.action === 'signIn' && (
          <Button variant="primary" onClick={onSignIn}>
            {t('header.signIn')}
          </Button>
        )}
        {view.action === 'upgrade' && <UpgradeButton variant="primary" />}
        {view.action === 'tryAgain' && (
          <Button variant="primary" onClick={onRetry}>
            {t('error.tryAgain')}
          </Button>
        )}
        {view.action === 'reload' && (
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('error.reload')}
          </Button>
        )}
        <Button variant={view.action === 'none' ? 'primary' : 'ghost'} onClick={onChangeFiles}>
          {t('error.changeFiles')}
        </Button>
      </div>
    </div>
  );
}
