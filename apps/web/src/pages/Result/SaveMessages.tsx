// What a failed save says (SPEC 11, 8.12): plain sentences for each limit and refusal, with the next step next to them - "Upgrade"
// for a limit a paid plan lifts, a way to My formats when a slot has to be freed, the problems the server found in the rules.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../../app/Me';
import { UpgradeButton } from '../../app/Upgrade';
import { flowErrorText } from '../../flow/errors';
import { useI18n } from '../../i18n';
import { Button, InlineMessage } from '../../ui';
import type { SaveFailure } from './useSave';

export interface SaveFailureMessageProps {
  failure: SaveFailure;
  onSignIn(): void;
  /** A title for the list of problems the server named (default: what stopped the save). */
  problemsTitle?: string;
}

const UPGRADE_LIMITS = new Set(['savedFormats', 'newFormatsPerMonth', 'sourcesPerFormat', 'rulesPerFormat', 'aiLearns']);

export function SaveFailureMessage({ failure, onSignIn, problemsTitle }: SaveFailureMessageProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const { refresh } = useMe();
  const sessionGone = failure.kind === 'api' && failure.code === 'signInRequired';
  // The session ended while the page was open: read who is signed in again, so "Sign in" works.
  useEffect(() => {
    if (sessionGone) void refresh();
  }, [sessionGone, refresh]);

  if (failure.code === 'signInRequired') {
    return (
      <InlineMessage
        tone="info"
        actions={
          <Button variant="primary" size="sm" onClick={onSignIn}>
            {t('header.signIn')}
          </Button>
        }
      >
        {t('signIn.save')}
      </InlineMessage>
    );
  }

  const text = flowErrorText(i18n, { kind: 'api', code: failure.code, limit: failure.limit, period: failure.period, counted: failure.counted });
  const knownFailure = failure.code === 'unknown' || failure.code === 'network' || failure.code === 'server';
  const upgrade = failure.code === 'limitHit' && failure.limit !== undefined && UPGRADE_LIMITS.has(failure.limit);
  const problems = failure.problems ?? [];
  return (
    <InlineMessage
      tone={knownFailure ? 'error' : 'warn'}
      actions={
        upgrade || failure.limit === 'savedFormats' ? (
          <>
            {failure.limit === 'savedFormats' ? <Link to="/formats">{t('account.myFormats')}</Link> : null}
            {upgrade ? <UpgradeButton /> : null}
          </>
        ) : undefined
      }
    >
      <p>{failure.code === 'unknown' ? t('save.failed') : text}</p>
      {problems.length > 0 && (
        <>
          <p className="msg__title">{problemsTitle ?? t('save.problems')}</p>
          <ul className="problem-list">
            {problems.map((p, i) => (
              <li key={i} lang="en" dir="ltr">
                {'message' in p ? p.message : p.kind}
              </li>
            ))}
          </ul>
        </>
      )}
    </InlineMessage>
  );
}
