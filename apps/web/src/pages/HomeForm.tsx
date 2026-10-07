import { useId, useRef, useState } from 'react';
import { AiLimitNotice, useAiLimit } from '../app/AiLimit';
import { aiUsesLabel, includedLabel, noAiLeft } from '../app/aiQuota';
import { SendPreviewDialog } from '../app/SendPreviewDialog';
import { useLearnSession } from '../app/LearnSession';
import { useMe } from '../app/Me';
import { useSignIn } from '../app/SignIn';
import { useFileInfo } from '../app/useFileInfo';
import { webConfig } from '../config';
import { useI18n } from '../i18n';
import { Button, Dialog, DropZone, Icon } from '../ui';
import { HomeMasking } from './HomeMasking';

export interface HomeFormProps {
  /** A learn has just started (before the progress screen takes over): the button shows it is working. */
  busy: boolean;
}

/** SPEC 16.1 screen 1, the tool itself: two drop zones, the masking switch, the privacy line, "Learn the format" and next to it "Learn with AI". */
export function HomeForm({ busy }: HomeFormProps) {
  const { t } = useI18n();
  const session = useLearnSession();
  const me = useMe();
  const signIn = useSignIn();
  const aiLimit = useAiLimit();
  const { input, output, masking } = session;
  const inputInfo = useFileInfo(input, 'input');
  const outputInfo = useFileInfo(output, 'output');
  const [sendOpen, setSendOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const zones = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const aiHintId = useId();

  const ready = input !== null && output !== null && inputInfo?.status !== 'unreadable' && outputInfo?.status !== 'unreadable';
  // Which of the two buttons started the learn that is running (the one that shows it is working).
  const withAi = session.deepAnalysis;
  // What "Learn with AI" costs, in one line: signed in, one AI format and only if it succeeds; a visitor, what signing in gives. With none
  // left (owner 2026-10-07) the line is a notice - when they come back, and the paid waitlist - and the button, still there, opens the dialog
  // that says it all and offers "Learn without AI".
  const noneLeft = me.user !== null && noAiLeft(me.quota);
  const aiHint = me.user ? aiUsesLabel(t, me.quota) : t('home.learnAi.guest', { included: includedLabel(t) });

  // "Clear" (owner, 2026-10-07): one click back to an empty form. Only a learned result that is not saved yet is worth a question - it
  // would be lost; then it is asked once. Focus goes to the first drop zone (the link itself is gone).
  const unsavedResult = session.flow.state.status === 'done' && session.flow.state.result.rules !== null && !session.saved;
  const clear = (): void => {
    setConfirmClear(false);
    session.startOver();
    requestAnimationFrame(() => zones.current?.querySelector<HTMLElement>('input')?.focus());
  };

  return (
    <div className="view">
      <header className="tool__head">
        <h1>{t('home.title')}</h1>
        <p className="lead">{t('home.lead')}</p>
      </header>

      <div className="zones" ref={zones}>
        <DropZone
          label={t('home.input.title')}
          caption={t('home.input.caption')}
          file={input}
          info={inputInfo}
          onFile={session.setInput}
          onClear={() => session.setInput(null)}
          maxBytes={webConfig.maxFileBytes}
          disabled={busy}
        />
        <span className="zones__arrow" aria-hidden="true">
          <Icon name="arrow" size={22} />
        </span>
        <DropZone
          label={t('home.output.title')}
          caption={t('home.output.caption')}
          file={output}
          info={outputInfo}
          onFile={session.setOutput}
          onClear={() => session.setOutput(null)}
          maxBytes={webConfig.maxFileBytes}
          disabled={busy}
        />
      </div>

      {input !== null || output !== null ? (
        <p className="zones__clear">
          <Button variant="link" disabled={busy} aria-label={t('home.clear.label')} onClick={() => (unsavedResult ? setConfirmClear(true) : clear())}>
            {t('home.clear')}
          </Button>
        </p>
      ) : null}

      <HomeMasking masking={masking} onChange={session.setMasking} disabled={busy} />

      <div className="privacy">
        <p className="privacy__line">
          <Icon name="lock" size={16} />
          <span>{t('masking.always')}</span>
          <Button variant="link" aria-haspopup="dialog" onClick={() => setSendOpen(true)}>
            {t('sendPanel.title')}
          </Button>
        </p>
        <SendPreviewDialog open={sendOpen} onClose={() => setSendOpen(false)} />
      </div>
      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} title={t('home.clear.confirm.title')}>
        <p>{t('home.clear.confirm.body')}</p>
        <div className="dialog__actions">
          <Button variant="primary" onClick={() => setConfirmClear(false)}>
            {t('home.clear.confirm.no')}
          </Button>
          <Button variant="secondary" onClick={clear}>
            {t('home.clear.confirm.yes')}
          </Button>
        </div>
      </Dialog>

      <div className="learn">
        <div className="learn-row">
          <Button
            variant="primary"
            iconEnd="arrow"
            disabled={!ready || (busy && withAi)}
            loading={busy && !withAi}
            aria-describedby={ready ? undefined : hintId}
            onClick={() => session.begin({ deep: false })}
          >
            {t('home.learn')}
          </Button>
          {/* The same learn, with the AI step to follow if the free engine leaves fields unsolved. A visitor is asked to sign in first (the learn then carries on by itself, see LearnSession). */}
          <Button
            variant="secondary"
            disabled={!ready || me.status === 'loading' || (busy && !withAi)}
            loading={busy && withAi}
            aria-describedby={ready ? aiHintId : `${aiHintId} ${hintId}`}
            onClick={() => (!me.user ? signIn.open('ai') : noneLeft ? aiLimit.open({ learnFree: true }) : session.begin({ deep: true }))}
          >
            {t('home.learnAi')}
          </Button>
          {!ready && (
            <p className="learn-row__hint" id={hintId}>
              {t('home.needFiles')}
            </p>
          )}
        </div>
        {noneLeft && me.quota ? (
          <AiLimitNotice period={me.quota.period} textId={aiHintId} />
        ) : (
          <p className="learn-row__hint" id={aiHintId} data-testid="learn-ai-hint">
            {aiHint}
          </p>
        )}
      </div>
    </div>
  );
}
