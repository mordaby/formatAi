import type { SentRecord } from '../flow/learnFlow';
import { useI18n } from '../i18n';
import { CodeBlock, Panel } from '../ui';

export interface SendPanelProps {
  /** What the browser has sent so far (`flow.state.sent`). Empty before the first learn call. */
  sent: readonly SentRecord[];
  /** The masking switch, so the "before" explanation matches what will go out. */
  masking: boolean;
  onClose(): void;
  id?: string;
}

/**
 * SPEC 15 "See what we send". Before anything is sent it says what WILL be sent; once a payload
 * exists it shows the exact JSON, in either masking mode. The Result screen reuses it.
 */
export function SendPanel({ sent, masking, onClose, id }: SendPanelProps) {
  const { t } = useI18n();
  return (
    <Panel title={t('sendPanel.title')} onClose={onClose} {...(id ? { id } : {})}>
      {sent.length === 0 ? (
        <>
          <p>{t('sendPanel.lead.before')}</p>
          <ul className="bullets">
            <li>{t('sendPanel.item.columns')}</li>
            <li>{t(masking ? 'sendPanel.item.rows.on' : 'sendPanel.item.rows.off')}</li>
            <li>{t('sendPanel.item.hints')}</li>
          </ul>
          <p className="muted">{t('sendPanel.note.before')}</p>
        </>
      ) : (
        <>
          <p>{t('sendPanel.lead.sent')}</p>
          {sent.map((rec, i) => (
            <div className="send-record" key={i}>
              <p className="send-record__head">
                {t(rec.kind === 'learn' ? 'sendPanel.kind.learn' : 'sendPanel.kind.repair')} · {t('sendPanel.size', { kb: (rec.bytes / 1024).toFixed(1) })}
              </p>
              <CodeBlock label={t('sendPanel.json')} json={rec.kind === 'learn' ? { payload: rec.payload } : { payload: rec.payload, previousRules: rec.previousRules, problems: rec.problems }} />
            </div>
          ))}
          <p className="muted">{t('masking.always')}</p>
        </>
      )}
    </Panel>
  );
}
