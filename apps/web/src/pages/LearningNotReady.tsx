import { aiReadinessMessages } from '@formatai/shared';
import { localize, useI18n } from '../i18n';
import { Button, InlineMessage } from '../ui';
import type { LearnOutput } from '../worker/engineApi';

/**
 * SPEC 21 v5 item 4: the AI readiness gate stopped the AI step, because it could not succeed. Each issue says what to fix; nothing
 * was used up (no AI format, no call).
 */
export function LearningNotReady({ result, onChangeFiles }: { result: LearnOutput; onChangeFiles(): void }) {
  const { t, lang } = useI18n();
  const readiness = result.readiness;
  const issues = readiness && !readiness.ready ? readiness.issues : [];
  return (
    <div className="view preflight">
      <header className="tool__head">
        <h1>{t('notReady.title')}</h1>
      </header>
      <div className="preflight__list">
        {issues.map((issue, n) => (
          <InlineMessage key={`${issue.code}-${n}`} tone="block" {...(n === issues.length - 1 ? { todo: t('notReady.nothingUsed') } : {})}>
            {localize(lang, aiReadinessMessages[issue.code], issue.params)}
          </InlineMessage>
        ))}
      </div>
      <div className="preflight__actions">
        <Button variant="primary" onClick={onChangeFiles}>
          {t('preflight.changeFiles')}
        </Button>
      </div>
    </div>
  );
}
