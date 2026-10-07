// What the AI step reported about the answer on screen (SPEC 21 v5): how many AI formats are left and - when the result did not match every
// row - which try this was, or that the tries on this example pair are used up. The Result screen and Add a source say it the same way.
import { limits } from '@formatai/shared';
import { aiLeftLabel } from '../../app/aiQuota';
import type { AiInfo } from '../../flow/learnFlow';
import { useI18n } from '../../i18n';
import { InlineMessage } from '../../ui';

/** What the AI step reported: how many AI formats are left, and - when the result did not match every row - which try this was. */
export function AiNote({ ai, verified }: { ai: AiInfo; verified: boolean }) {
  const i18n = useI18n();
  const { t, code } = i18n;
  const max = limits.learn.maxFailedAiAttempts;
  const tried = ai.failedAttempts ?? 0;
  if (!ai.quota && !ai.exhausted && (verified || tried === 0)) return null;
  return (
    <div className="ai-note" data-testid="ai-note">
      {ai.exhausted ? (
        <InlineMessage tone="warn" title={t('aiExhausted.title', { n: max })} todo={t('aiExhausted.todo')}>
          {code({ kind: 'apiError', code: 'aiAttemptsExhausted', counted: ai.counted === true })}
        </InlineMessage>
      ) : !verified && tried > 0 ? (
        <InlineMessage tone="info">{t('ai.attempt', { n: tried, max })}</InlineMessage>
      ) : null}
      {ai.quota ? <p className="muted tabular">{aiLeftLabel(i18n, ai.quota)}</p> : null}
    </div>
  );
}
