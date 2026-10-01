// The free result before the AI step (SPEC 21 v5 item 1): what code alone could work out is shown with everything the AI
// step still has to do marked (the panel next to it is DeepAnalysisPanel), and a visitor is asked - once, in a popup - to sign in free to finish. Every column code could not
// explain needs the AI step, including those it found no trace of in the input (those say "may come from another source").
import type { PartialInfo } from '@formatai/engine';
import { includedLabel } from '../../app/aiQuota';
import { SignInButtons } from '../../app/SignIn';
import { useI18n } from '../../i18n';
import { Button, Dialog } from '../../ui';

/** The counts the popup and the banner say: "N of M columns" worked out, K need the AI step (every column code could not explain). */
export function partialCounts(partial: PartialInfo, totalColumns: number) {
  return { solved: partial.solved.length, total: totalColumns, needsAi: partial.needsAi.length, parts: partial.needsAiParts.length };
}

/**
 * "We worked out N of M columns on your computer. K need the AI step - sign in free to finish (3 AI formats a month included)."
 * The sentence follows what is left: columns, or only layout parts.
 */
export function partialPopupText(t: ReturnType<typeof useI18n>['t'], partial: PartialInfo, totalColumns: number): string {
  const c = partialCounts(partial, totalColumns);
  const included = includedLabel(t);
  if (c.needsAi > 0) return t(c.needsAi === 1 ? 'partial.popup.one' : 'partial.popup.other', { solved: c.solved, total: c.total, needsAi: c.needsAi, included });
  return t('partial.popup.parts', { solved: c.solved, total: c.total, included });
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
