import { limits, newCheckRows } from '@formatai/shared';
import { sentBody, type SentRecord } from '../flow/learnFlow';
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
 * exists it shows the exact JSON, in either masking mode - the learn request, every step of AI code
 * checks (the checks and your computer's answers) and every round of the learning loop, each with
 * the rows of the example it carries. The Result screen reuses it.
 */
export function SendPanel({ sent, masking, onClose, id }: SendPanelProps) {
  const { t } = useI18n();
  const kindOf = (rec: SentRecord): string =>
    rec.kind === 'learn'
      ? t('sendPanel.kind.learn')
      : rec.kind === 'step'
        ? t('sendPanel.kind.step', { n: rec.round?.n ?? rec.rounds?.length ?? 1, of: rec.round?.of ?? limits.learn.checks.maxRounds })
        : rec.fresh
          ? t('sendPanel.kind.fresh', { n: rec.round?.n ?? 1, of: rec.round?.of ?? limits.learn.loop.maxRounds })
          : rec.round
            ? t('sendPanel.kind.round', { n: rec.round.n, of: rec.round.of })
            : t('sendPanel.kind.repair');
  /** The rows of the example a request carries beyond the payload's own: a loop round's rows, or the rows a step's answers show. */
  const rowsNote = (rec: SentRecord): string | null => {
    if (rec.fresh) return t('sendPanel.fresh.note');
    if (rec.kind === 'step') {
      const n = rec.rounds ? newCheckRows(rec.payload, rec.rounds) : 0;
      return n > 0 ? t(n === 1 ? 'sendPanel.checkRows.one' : 'sendPanel.checkRows.other', { n }) : null;
    }
    return rec.rows && rec.rows.length > 0 ? t(rec.rows.length === 1 ? 'sendPanel.rows.one' : 'sendPanel.rows.other', { n: rec.rows.length }) : null;
  };
  return (
    <Panel title={t('sendPanel.title')} onClose={onClose} {...(id ? { id } : {})}>
      {sent.length === 0 ? (
        <>
          <p>{t('sendPanel.lead.before')}</p>
          <ul className="bullets">
            <li>{t('sendPanel.item.columns')}</li>
            <li>{t(masking ? 'sendPanel.item.rows.on' : 'sendPanel.item.rows.off')}</li>
            <li>{t('sendPanel.item.hints')}</li>
            <li>{t('sendPanel.item.checks', { rows: limits.learn.loop.maxRowsTotal })}</li>
            <li>{t('sendPanel.item.loop', { rounds: limits.learn.loop.maxRounds, rows: limits.learn.loop.maxRowsTotal })}</li>
          </ul>
          <p className="muted">{t('sendPanel.note.before')}</p>
        </>
      ) : (
        <>
          <p>{t('sendPanel.lead.sent')}</p>
          {sent.map((rec, i) => {
            const note = rowsNote(rec);
            return (
              <div className="send-record" key={i} data-testid="send-record">
                <p className="send-record__head">
                  {kindOf(rec)} · {t('sendPanel.size', { kb: (rec.bytes / 1024).toFixed(1) })}
                </p>
                {note ? <p className="muted">{note}</p> : null}
                <CodeBlock label={t('sendPanel.json')} json={sentBody(rec)} />
              </div>
            );
          })}
          <p className="muted">{t('masking.always')}</p>
        </>
      )}
    </Panel>
  );
}
