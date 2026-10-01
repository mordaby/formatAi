import { useId, useState } from 'react';
import { SendPanel } from '../app/SendPanel';
import { useLearnSession } from '../app/LearnSession';
import { useMe } from '../app/Me';
import { useFileInfo } from '../app/useFileInfo';
import { webConfig } from '../config';
import { useI18n } from '../i18n';
import { Button, DropZone, Icon } from '../ui';
import { HomeMasking } from './HomeMasking';

export interface HomeFormProps {
  /** A learn has just started (before the progress screen takes over): the button shows it is working. */
  busy: boolean;
}

/** SPEC 16.1 screen 1, the tool itself: two drop zones, the masking switch, the privacy line, one primary button. */
export function HomeForm({ busy }: HomeFormProps) {
  const { t } = useI18n();
  const session = useLearnSession();
  const me = useMe();
  const { input, output, masking } = session;
  const inputInfo = useFileInfo(input, 'input');
  const outputInfo = useFileInfo(output, 'output');
  const [sendOpen, setSendOpen] = useState(false);
  const sendId = useId();
  const hintId = useId();
  const deepId = useId();
  const deepHintId = useId();

  const ready = input !== null && output !== null && inputInfo?.status !== 'unreadable' && outputInfo?.status !== 'unreadable';

  return (
    <div className="view">
      <header className="tool__head">
        <h1>{t('home.title')}</h1>
        <p className="lead">{t('home.lead')}</p>
      </header>

      <div className="zones">
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

      <HomeMasking masking={masking} onChange={session.setMasking} disabled={busy} />

      {/* Signed in: the AI step is the user's choice. Off, the free engine's result is shown and the Result screen offers the AI step; on, it starts by itself when fields are missing. */}
      {me.user ? (
        <div className="check deep-pref" data-testid="deep-analysis-pref">
          <input
            id={deepId}
            type="checkbox"
            className="check__box"
            checked={session.deepAnalysis}
            disabled={busy}
            aria-describedby={deepHintId}
            onChange={(e) => session.setDeepAnalysis(e.target.checked)}
          />
          <label htmlFor={deepId} className="check__label">
            {t('deep.pref')}
          </label>
          <p className="field__hint" id={deepHintId}>
            {t('deep.pref.hint')}
          </p>
        </div>
      ) : null}

      <div className="privacy">
        <p className="privacy__line">
          <Icon name="lock" size={16} />
          <span>{t('masking.always')}</span>
          <Button variant="link" aria-expanded={sendOpen} aria-controls={sendOpen ? sendId : undefined} onClick={() => setSendOpen((o) => !o)}>
            {t('sendPanel.title')}
          </Button>
        </p>
        {sendOpen && <SendPanel id={sendId} sent={session.flow.state.sent} masking={masking} onClose={() => setSendOpen(false)} />}
      </div>

      <div className="learn-row">
        <Button variant="primary" iconEnd="arrow" disabled={!ready} loading={busy} aria-describedby={ready ? undefined : hintId} onClick={() => session.begin()}>
          {t('home.learn')}
        </Button>
        {!ready && (
          <p className="learn-row__hint" id={hintId}>
            {t('home.needFiles')}
          </p>
        )}
      </div>
    </div>
  );
}
