// Leaving with unsaved changes asks first (SPEC 8.11 "Saving"): closing or reloading the tab gets the browser's own prompt, and
// going to another screen of the app - a link, the back button - gets this dialog. Both only while `when` is true.
import { useContext, useEffect } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Button, Dialog } from '../ui';
import { confirmUnload } from './unloadPrompt';

/** "Leave without saving?": Keep editing (the safe way out, and Escape) or Leave. */
export function LeaveDialog({ open, onStay, onLeave }: { open: boolean; onStay(): void; onLeave(): void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onStay} title={t('leave.title')}>
      <p>{t('leave.text')}</p>
      <div className="dialog__actions">
        <Button variant="primary" onClick={onStay}>
          {t('leave.stay')}
        </Button>
        <Button variant="secondary" onClick={onLeave}>
          {t('leave.leave')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Screen changes inside the app. Needs the app's data router; without one (a test that renders a plain router) only the tab prompt applies. */
function RouteBlocker({ when }: { when: boolean }) {
  // Only a change of screen is asked about: a sign-in return that just tidies the address (same path) goes through.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  return (
    <LeaveDialog
      open={blocker.state === 'blocked'}
      onStay={() => blocker.state === 'blocked' && blocker.reset()}
      onLeave={() => blocker.state === 'blocked' && blocker.proceed()}
    />
  );
}

export function LeaveGuard({ when }: { when: boolean }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!when) return;
    window.addEventListener('beforeunload', confirmUnload);
    return () => window.removeEventListener('beforeunload', confirmUnload);
  }, [when]);
  return dataRouter ? <RouteBlocker when={when} /> : null;
}
