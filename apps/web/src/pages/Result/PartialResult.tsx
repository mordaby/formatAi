// The local result before the AI step (SPEC 21 v5 items 1 and 4): what code alone could work out is shown with everything the AI
// step still has to do marked, and a visitor is asked - once, in a popup - to sign in free to finish. When the only thing left is
// data that is not in the input file at all (no AI could produce it), it is the finished local result and only says so.
import type { AiReadiness, PartialInfo } from '@formatai/engine';
import { aiReadinessMessages } from '@formatai/shared';
import { aiLeftLabel, includedLabel } from '../../app/aiQuota';
import { useMe } from '../../app/Me';
import { SignInButtons } from '../../app/SignIn';
import { localize, useI18n } from '../../i18n';
import { Button, Dialog, InlineMessage } from '../../ui';

/** The counts the popup and the banner say: "N of M columns" worked out, K need the AI step, E need the user's input. */
export function partialCounts(partial: PartialInfo, totalColumns: number) {
  return { solved: partial.solved.length, total: totalColumns, needsAi: partial.needsAi.length, external: partial.external.length, parts: partial.needsAiParts.length };
}

/**
 * "We worked out N of M columns on your computer. K need the AI step - sign in free to finish (3 AI formats a month included)."
 * The sentence follows what is left: columns, only layout parts, and (when there are any) the columns that need the user's input.
 */
export function partialPopupText(t: ReturnType<typeof useI18n>['t'], partial: PartialInfo, totalColumns: number): string {
  const c = partialCounts(partial, totalColumns);
  const included = includedLabel(t);
  let text: string;
  if (c.needsAi > 0) text = t(c.needsAi === 1 ? 'partial.popup.one' : 'partial.popup.other', { solved: c.solved, total: c.total, needsAi: c.needsAi, included });
  else text = t('partial.popup.parts', { solved: c.solved, total: c.total, included });
  if (c.external > 0) text += t(c.external === 1 ? 'partial.popup.external.one' : 'partial.popup.external.other', { n: c.external });
  return text;
}

export function PartialSignInDialog({ open, partial, totalColumns, onClose }: { open: boolean; partial: PartialInfo; totalColumns: number; onClose(): void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('partial.popup.title')}>
      <p data-testid="partial-popup-text">{partialPopupText(t, partial, totalColumns)}</p>
      <SignInButtons />
      <div className="dialog__foot">
        <Button variant="ghost" onClick={onClose}>
          {t('partial.popup.later')}
        </Button>
      </div>
      <p className="muted">
        {t('signIn.kept')} {t('signIn.keptLocal')}
      </p>
    </Dialog>
  );
}

/** The message above the map of a local result: what was worked out, what waits for the AI step (or for the user), and how many AI formats are left. */
export function PartialBanner({ partial, totalColumns, readiness }: { partial: PartialInfo; totalColumns: number; readiness: AiReadiness | undefined }) {
  const { t, lang } = useI18n();
  const me = useMe();
  const c = partialCounts(partial, totalColumns);

  if (partial.reason === 'onlyExternalColumns') {
    const issue = readiness && !readiness.ready ? readiness.issues.find((i) => i.code === 'onlyExternalColumns') : undefined;
    return (
      <InlineMessage tone="info" title={t('partial.onlyExternal.title')} todo={t('partial.onlyExternal.todo')}>
        {issue ? localize(lang, aiReadinessMessages.onlyExternalColumns, issue.params as Record<string, string | number>) : partial.external.join(', ')}
      </InlineMessage>
    );
  }

  return (
    <InlineMessage tone="info" title={t('partial.section')} todo={t('partial.finishNote')}>
      <p>{me.user ? t('partial.banner.signedIn') : t('partial.banner.anon', { solved: c.solved, total: c.total })}</p>
      {me.user ? <p className="muted">{t('complete.finishNote')}</p> : null}
      {me.user && me.quota ? <p className="tabular">{aiLeftLabel(t, me.quota)}</p> : null}
    </InlineMessage>
  );
}
