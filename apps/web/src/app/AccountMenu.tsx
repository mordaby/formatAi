import type { AuthProviderId, MeUser } from '@formatai/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cell } from '../components/Cell';
import { useI18n } from '../i18n';
import { Badge, Button, Icon, InlineMessage } from '../ui';
import { aiLeftLabel } from './aiQuota';
import { useFeedback } from './Feedback';
import { useMe } from './Me';
import { useSignIn } from './SignIn';

function initialOf(user: MeUser): string {
  const source = (user.name ?? user.email ?? '?').trim();
  return (Array.from(source)[0] ?? '?').toUpperCase();
}

/** The avatar the provider gave, or the first letter of the name when there is none (or it does not load). */
function Avatar({ user }: { user: MeUser }) {
  const [broken, setBroken] = useState(false);
  if (user.avatarUrl && !broken) {
    return <img className="avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar avatar--letter" aria-hidden="true">
      {initialOf(user)}
    </span>
  );
}

/** The header's account area: "Sign in" for a visitor, and for a signed-in user a menu with what belongs to the account. */
export function AccountMenu() {
  const { t } = useI18n();
  const me = useMe();
  const signIn = useSignIn();
  const feedback = useFeedback();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<'signOut' | 'link' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const user = me.user;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) {
    return (
      <Button variant="secondary" size="sm" onClick={() => signIn.open('save')}>
        {t('header.signIn')}
      </Button>
    );
  }

  const name = user.name ?? user.email ?? t('account.signedIn');
  const otherProviders: AuthProviderId[] = (me.providers ?? []).filter((p) => !user.providers.includes(p));

  const signOut = async (): Promise<void> => {
    setProblem(null);
    if (await me.signOut()) {
      setOpen(false);
      navigate('/');
    } else setProblem('signOut');
  };
  const link = async (provider: AuthProviderId): Promise<void> => {
    setProblem(null);
    if (!(await me.linkProvider(provider))) setProblem('link');
  };

  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account__button"
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('account.menuLabel', { name })}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar user={user} />
        <span className="account__name">
          <Cell value={name} />
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="account__panel" id={panelId} role="group" aria-label={t('account.menu')}>
          <div className="account__who">
            <p className="account__title">
              <Cell value={name} />
            </p>
            {user.email && user.email !== name ? <p className="muted account__email">{user.email}</p> : null}
            <p>
              <Badge tone={user.tier === 'paid' ? 'verified' : 'neutral'}>{t(user.tier === 'paid' ? 'account.tier.paid' : 'account.tier.registered')}</Badge>
            </p>
            {me.quota ? <p className="account__quota tabular">{aiLeftLabel(t, me.quota)}</p> : null}
          </div>
          <ul className="account__list">
            <li>
              <Link className="account__item" to="/convert" onClick={() => setOpen(false)}>
                {t('conv.nav')}
              </Link>
            </li>
            <li>
              <Link className="account__item" to="/formats" onClick={() => setOpen(false)}>
                {t('account.myFormats')}
              </Link>
            </li>
            {otherProviders.map((provider) => (
              <li key={provider}>
                <button type="button" className="account__item" onClick={() => void link(provider)}>
                  {t('account.linkProvider', { provider: t(provider === 'google' ? 'provider.google' : 'provider.microsoft') })}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="account__item"
                onClick={() => {
                  // The menu closes, so its item is gone: the focus goes back to the menu button first, and that is where the dialog returns it.
                  setOpen(false);
                  trigger.current?.focus();
                  feedback.open();
                }}
              >
                {t('footer.feedback')}
              </button>
            </li>
            <li>
              <button type="button" className="account__item" onClick={() => void signOut()}>
                {t('account.signOut')}
              </button>
            </li>
          </ul>
          {problem ? <InlineMessage tone="error">{t(problem === 'signOut' ? 'account.signOutFailed' : 'account.linkFailed')}</InlineMessage> : null}
        </div>
      )}
    </div>
  );
}

/** What the provider's redirect said (`?authError=` / `?linked=`), once, in plain words. */
export function AuthNoticeBar() {
  const { t } = useI18n();
  const { notice, dismissNotice } = useMe();
  if (!notice) return null;
  const linked = notice.kind === 'linked';
  const text = linked
    ? t('auth.linked', { provider: t(notice.provider === 'google' ? 'provider.google' : 'provider.microsoft') })
    : t(`auth.error.${notice.code}` as const);
  return (
    <div className="auth-notice">
      <InlineMessage tone={linked ? 'info' : notice.code === 'denied' ? 'info' : 'warn'} actions={<Button variant="ghost" size="sm" onClick={dismissNotice}>{t('auth.dismiss')}</Button>}>
        {text}
      </InlineMessage>
    </div>
  );
}
