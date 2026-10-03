// Who may use Convert and Batch (SPEC 5 E, 11): both need an account, so a visitor who is signed out meets the sign-in wall
// here, not an empty tool. Who is signed in comes from the app's `useMe()`.
import type { MeUser } from '@formatai/shared';
import type { ReactNode } from 'react';
import { useMe } from '../../app/Me';
import { useSignIn } from '../../app/SignIn';
import { useI18n, type MessageKey } from '../../i18n';
import { Button, InlineMessage, Spinner } from '../../ui';

export interface AccountGateProps {
  /** The wall's heading and text (Convert and Batch each say what they need the account for). */
  title: MessageKey;
  text: MessageKey;
  children(user: MeUser): ReactNode;
}

export function AccountGate({ title, text, children }: AccountGateProps) {
  const { t } = useI18n();
  const signIn = useSignIn();
  const me = useMe();
  if (me.status === 'loading') {
    return (
      <p className="muted conv__wait" role="status">
        <Spinner size={16} /> {t('conv.checkingAccount')}
      </p>
    );
  }
  if (me.user === null) {
    return (
      <InlineMessage
        tone="info"
        title={t(title)}
        actions={
          <Button variant="primary" onClick={() => signIn.open('keepGoing')}>
            {t('conv.wall.button')}
          </Button>
        }
      >
        {t(text)}
      </InlineMessage>
    );
  }
  return <>{children(me.user)}</>;
}
