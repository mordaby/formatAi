// What the AI step's completion run says on the Result screen (see `useCompletion`): that it is working, that it finished, or - in
// plain words - why the rules were kept as they were. And "See what we send" (SPEC 15): the completion call has its own payload (the
// rules on screen, masked like the samples, and what is missing), so the exact JSON is one click away here too.
import { aiReadinessMessages } from '@formatai/shared';
import { useId, useState } from 'react';
import { errorView } from '../../app/messages';
import { useLearnSession } from '../../app/LearnSession';
import { SendPanel } from '../../app/SendPanel';
import { localize, useI18n } from '../../i18n';
import { Button, InlineMessage, Spinner } from '../../ui';
import type { UseCompletion } from './useCompletion';

export function CompletionNotice({ completion }: { completion: UseCompletion }) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const session = useLearnSession();
  const sent = session.completion.state.sent;
  const [sendOpen, setSendOpen] = useState(false);
  const sendId = useId();
  const { running, columnsAsked, outcome } = completion;

  const notice = (() => {
    if (running) {
      return (
        <InlineMessage tone="info">
          <p data-testid="completion-running">
            <Spinner size={14} /> {t('complete.running')}
          </p>
          {columnsAsked > 0 ? <p className="muted">{t(columnsAsked === 1 ? 'complete.runningColumns.one' : 'complete.runningColumns.other', { n: columnsAsked })}</p> : null}
        </InlineMessage>
      );
    }
    if (!outcome) return null;
    if (outcome.kind === 'done') {
      return (
        <InlineMessage tone="info">
          <p data-testid="completion-done">{t('complete.done')}</p>
        </InlineMessage>
      );
    }
    if (outcome.kind === 'kept') {
      const text =
        outcome.why === 'lock'
          ? t('complete.kept.lock')
          : outcome.why === 'mismatch'
            ? t('complete.kept.mismatch')
            : outcome.why === 'nothing'
              ? t('complete.kept.nothing')
              : t('complete.kept.changed');
      return (
        <InlineMessage tone="warn" title={t('complete.kept.title')} todo={t('complete.kept.todo')}>
          <p data-testid="completion-kept">{text}</p>
        </InlineMessage>
      );
    }
    if (outcome.kind === 'notReady') {
      const readiness = outcome.result.readiness;
      const issues = readiness && !readiness.ready ? readiness.issues : [];
      return (
        <InlineMessage tone="block" title={t('notReady.title')} todo={t('notReady.nothingUsed')}>
          {issues.map((issue, n) => (
            <p key={`${issue.code}-${n}`} data-testid="completion-notready">
              {localize(lang, aiReadinessMessages[issue.code], issue.params)}
            </p>
          ))}
        </InlineMessage>
      );
    }
    const view = errorView(i18n, outcome.error);
    return (
      <InlineMessage tone={view.tone} title={t('complete.kept.title')} {...(view.todo ? { todo: view.todo } : {})}>
        <p data-testid="completion-error">{view.text}</p>
      </InlineMessage>
    );
  })();

  return (
    <>
      {notice}
      {sent.length > 0 && (
        <p className="privacy__line">
          <Button variant="link" aria-expanded={sendOpen} aria-controls={sendOpen ? sendId : undefined} onClick={() => setSendOpen((o) => !o)}>
            {t('sendPanel.title')}
          </Button>
        </p>
      )}
      {sendOpen && sent.length > 0 && <SendPanel id={sendId} sent={sent} masking={session.masking} onClose={() => setSendOpen(false)} />}
    </>
  );
}
