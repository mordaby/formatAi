// Out of AI formats (SPEC 11, owner 2026-10-07): one dialog and one notice say it the same way everywhere an AI step is asked for with
// none left - how many the plan includes, the date they come back, that the free engine and every saved format keep working - and offer
// the paid waitlist. Nothing changes for whoever still has AI formats left: no extra step, the quiet hint stays.
import { tiers, type AiLearnPeriod } from '@formatai/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowError } from '../flow/errors';
import { useI18n } from '../i18n';
import { Button, Dialog, InlineMessage } from '../ui';
import { aiOutLine, aiPlanLine } from './aiQuota';
import { useLearnSession } from './LearnSession';
import { useMe } from './Me';
import { UpgradeBody, UpgradeButton } from './Upgrade';

/** The API refused the AI step because the period's AI formats are used up (429 `limitHit { limit: 'aiLearns', period }`). */
export function isAiQuotaHit(error: FlowError | undefined): error is FlowError & { kind: 'api' } {
  return error?.kind === 'api' && error.code === 'limitHit' && error.limit === 'aiLearns';
}

export interface AiLimitApi {
  /**
   * Opens "You've used your AI formats for this month". `learnFree`: also offer "Learn without AI" - the normal free learn of the two files in
   * the session (Home, where they are ready). `period`: the one the server counted, when it said (a refusal); otherwise the known quota's.
   */
  open(opts?: { learnFree?: boolean; period?: AiLearnPeriod | undefined }): void;
}

const AiLimitContext = createContext<AiLimitApi | null>(null);

export function useAiLimit(): AiLimitApi {
  const ctx = useContext(AiLimitContext);
  if (!ctx) throw new Error('useAiLimit must be used inside <AiLimitProvider>');
  return ctx;
}

/**
 * Owns the dialog, and turns a refusal for the quota into it (a race: the AI formats were used up elsewhere since this page last read what
 * is left). The known quota becomes 0, so the screens show the notice too. A whole learn refused that way (the main flow) goes back to Home's
 * form - the files kept - instead of an error screen, with "Learn without AI" offered; a refused "Finish with AI" (the completion flow) leaves
 * the Result screen as it was.
 */
export function AiLimitProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const session = useLearnSession();
  const [state, setState] = useState<{ open: boolean; learnFree: boolean; period: AiLearnPeriod | undefined }>({ open: false, learnFree: false, period: undefined });

  const open = useCallback((opts?: { learnFree?: boolean; period?: AiLearnPeriod | undefined }) => {
    setState({ open: true, learnFree: opts?.learnFree === true, period: opts?.period });
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  const { setQuota } = me;
  const handled = useRef<object | null>(null);
  const mainError = session.flow.state.status === 'error' ? session.flow.state.error : undefined;
  const completionError = session.completion.state.status === 'error' ? session.completion.state.error : undefined;
  const { reset } = session.flow;
  useEffect(() => {
    const error = isAiQuotaHit(mainError) ? mainError : isAiQuotaHit(completionError) ? completionError : undefined;
    if (!error || handled.current === error) return;
    handled.current = error;
    const period = error.period ?? me.quota?.period;
    if (period) setQuota({ remaining: 0, period });
    if (error === mainError) reset();
    open({ learnFree: error === mainError, period });
  }, [mainError, completionError, reset, setQuota, open, me.quota?.period]);

  const value = useMemo<AiLimitApi>(() => ({ open }), [open]);
  return (
    <AiLimitContext.Provider value={value}>
      {children}
      <AiLimitDialog
        open={state.open && me.user !== null}
        period={state.period ?? me.quota?.period ?? tiers[me.tier].aiLearns.period}
        learnFree={state.learnFree && session.input !== null && session.output !== null}
        onLearnFree={() => {
          close();
          session.begin({ deep: false });
        }}
        onClose={close}
      />
    </AiLimitContext.Provider>
  );
}

export interface AiLimitDialogProps {
  open: boolean;
  period: AiLearnPeriod;
  /** Offer "Learn without AI". */
  learnFree: boolean;
  onLearnFree(): void;
  onClose(): void;
}

/**
 * "You've used your AI formats for this month": what the plan includes and when they come back, that the free engine and the saved formats
 * keep working, and three ways on - the paid waitlist (in the same dialog, the upgrade's own form), "Learn without AI", Close. A paid plan is
 * not offered the waitlist it is already past.
 */
export function AiLimitDialog({ open, period, learnFree, onLearnFree, onClose }: AiLimitDialogProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const me = useMe();
  const [view, setView] = useState<'limit' | 'waitlist'>('limit');
  const body = useRef<HTMLDivElement>(null);
  // (each opening starts from the limit itself)
  useEffect(() => {
    if (!open) setView('limit');
  }, [open]);
  // The button that opened the form is gone: the focus goes to the form's first field.
  useEffect(() => {
    if (view === 'waitlist') body.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
  }, [view]);

  const offerWaitlist = me.tier !== 'paid';
  const now = new Date();
  const titleKey = period === 'month' || period === 'day' ? (`aiOut.title.${period}` as const) : 'aiOut.title.lifetime';
  return (
    <Dialog open={open} onClose={onClose} title={view === 'waitlist' ? t('upgrade.title') : t(titleKey)}>
      {view === 'waitlist' ? (
        <div className="ai-out__waitlist" ref={body}>
          <UpgradeBody trigger="aiLearns" />
        </div>
      ) : (
        <>
          <div className="ai-out__text" data-testid="ai-out-dialog">
            <p>{aiPlanLine(i18n, me.tier, period, now)}</p>
            <p>{t('aiOut.free')}</p>
          </div>
          <div className="dialog__actions">
            {offerWaitlist ? (
              <Button variant="primary" onClick={() => setView('waitlist')}>
                {t('aiOut.waitlist')}
              </Button>
            ) : null}
            {learnFree ? (
              <Button variant={offerWaitlist ? 'secondary' : 'primary'} onClick={onLearnFree}>
                {t('aiOut.learnFree')}
              </Button>
            ) : null}
            <Button variant={offerWaitlist || learnFree ? 'ghost' : 'primary'} onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export interface AiLimitNoticeProps {
  period: AiLearnPeriod;
  /** An id for the line itself (what a button's `aria-describedby` points at). */
  textId?: string;
}

/** The notice where the quiet hint was: "No AI formats left this month · back on 1 November", and "Join the paid waitlist" (not on a paid plan). */
export function AiLimitNotice({ period, textId }: AiLimitNoticeProps) {
  const i18n = useI18n();
  const me = useMe();
  return (
    <div className="ai-out" data-testid="ai-out-notice">
      <InlineMessage tone="warn" actions={me.tier !== 'paid' ? <UpgradeButton variant="link" label="aiOut.waitlist" trigger="aiLearns" /> : undefined}>
        <p id={textId}>{aiOutLine(i18n, period)}</p>
      </InlineMessage>
    </div>
  );
}
