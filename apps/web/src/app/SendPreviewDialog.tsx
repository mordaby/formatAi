// "See what we send" before the learn (owner, 2026-10-07; SPEC 15): a large dialog (a full-screen sheet on phones), opened from Home's
// link - never on the main screen, no new click in the normal flow. It shows the sample rows the AI step would get, exactly as they would
// go (masked values where masked, real ones where real; input and output side by side, as the payload's samples are), with a switch per
// column: Hidden / Sent as is, preset by the column classification. Flipping one builds the request again at once.
//
// The rows are the request: the worker builds them with the learn's own payload builder and masker and the session's key (engine
// `sendPreview`, the same `aiRequestOf` the learn calls), from the analysis it keeps for these files (the first time it reads them, with
// progress). The choices are the session's (`LearnSession.columnChoices`): every request of the learns of these files follows them; another
// file clears them. With masking off, every column is sent as it is and the switches wait for masking to be turned on.
import type { ColumnChoice, SendColumn, SendPreview, UserColumnChoices } from '@formatai/engine';
import type { IdentifierKind, PayloadCell, Sample, Tier } from '@formatai/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { learnRequest } from '../api/learnRequests';
import { Cell } from '../components/Cell';
import { isCancellation } from '../flow/errors';
import { useI18n, type MessageKey } from '../i18n';
import { useServices } from '../services';
import { Button, CodeBlock, Dialog, InlineMessage, Progress } from '../ui';
import { useLearnSession } from './LearnSession';
import { useMe } from './Me';
import { SendBefore, SentRecords } from './SendPanel';

type Side = 'input' | 'output';
type Columns = SendPreview['columns'];

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; fraction: number }
  | { status: 'failed' }
  | { status: 'done'; preview: SendPreview };

/**
 * The preview of these two files, built again whenever masking or the choices change. The worker keeps the files' analysis under an id: the
 * first call sends the files (reading and analyzing them, with progress), the next ones the id only; a worker that no longer holds it
 * (`gone`: it restarted) is sent the files again.
 */
export function useSendPreview(opts: { input: File | null; output: File | null; masking: boolean; choices: UserColumnChoices; tier: Tier; enabled: boolean }): PreviewState {
  const { engine } = useServices();
  const { input, output, masking, choices, tier, enabled } = opts;
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const held = useRef<{ input: File; output: File; id: string } | null>(null);

  useEffect(() => {
    if (!enabled || !input || !output) {
      if (!input || !output) setState({ status: 'idle' });
      return;
    }
    const abort = new AbortController();
    let alive = true;
    const base = { masking, tier, ...(Object.keys(choices.input ?? {}).length + Object.keys(choices.output ?? {}).length > 0 ? { choices } : {}) };
    (async () => {
      const kept = held.current && held.current.input === input && held.current.output === output ? held.current : null;
      let out = kept ? await engine.sendPreview({ ...base, previewId: kept.id }, { signal: abort.signal }) : null;
      if (!out || (!out.ok && out.reason === 'gone')) {
        if (alive) setState({ status: 'loading', fraction: 0 });
        const [a, b] = await Promise.all([input.arrayBuffer(), output.arrayBuffer()]);
        if (!alive) return;
        out = await engine.sendPreview(
          { ...base, input: { name: input.name, bytes: a }, output: { name: output.name, bytes: b } },
          { signal: abort.signal, onProgress: (p) => alive && setState({ status: 'loading', fraction: p.fraction }) },
        );
      }
      if (!alive) return;
      if (out.ok) {
        held.current = { input, output, id: out.previewId };
        const { ok: _ok, previewId: _id, ...preview } = out;
        setState({ status: 'done', preview: preview as SendPreview });
      } else setState({ status: 'failed' });
    })().catch((e: unknown) => {
      if (alive && !isCancellation(e)) setState({ status: 'failed' });
    });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [engine, input, output, masking, choices, tier, enabled]);

  return state;
}

/** What a flip asked, to say what it did once the new preview is in. */
interface Flip {
  side: Side;
  index: number;
  hidden: boolean;
  before: Columns;
}

/**
 * A column as the dialog names it: its header, with its side when the other side (or its own) has a column of the same name - a copy is
 * "ID (input)" and "ID (output)", so two switches never share a name.
 */
function columnName(columns: Columns, side: Side, index: number, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  const header = columns[side][index]?.header ?? '';
  if (header === '') return `#${index + 1}`;
  const same = [...columns.input, ...columns.output].filter((c) => c.header === header).length;
  return same > 1 ? t(side === 'input' ? 'sendPreview.side.input' : 'sendPreview.side.output', { column: header }) : header;
}

const WARN: Record<IdentifierKind, MessageKey> = {
  israeliId: 'sendPreview.warn.israeliId',
  phone: 'sendPreview.warn.phone',
  email: 'sendPreview.warn.email',
  card: 'sendPreview.warn.card',
  iban: 'sendPreview.warn.iban',
};

export function SendPreviewDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const session = useLearnSession();
  const me = useMe();
  const { input, output, masking, columnChoices } = session;
  const state = useSendPreview({ input, output, masking, choices: columnChoices, tier: me.tier, enabled: open });
  const sent = session.flow.state.sent;
  const flip = useRef<Flip | null>(null);
  const [notes, setNotes] = useState<{ tone: 'warn' | 'info'; text: string }[]>([]);
  const preview = state.status === 'done' ? state.preview : null;
  const sentId = useId();

  // Another example, or masking turned on or off: the last flip's notes are about something else.
  useEffect(() => setNotes([]), [input, output, masking]);
  // A flip's notes, once its preview is in: un-hiding what code found to be identifiers, hiding real values, and the columns that went with it.
  useEffect(() => {
    const f = flip.current;
    if (!f || !preview) return;
    flip.current = null;
    const col = f.before[f.side][f.index];
    if (!col) return;
    const name = columnName(f.before, f.side, f.index, t);
    const next: { tone: 'warn' | 'info'; text: string }[] = [];
    if (!f.hidden && col.class === 'identifier') next.push({ tone: 'warn', text: t(col.identifier?.shape ? WARN[col.identifier.shape] : 'sendPreview.warn.identifier', { column: name }) });
    if (f.hidden && !col.hiddenByDefault) next.push({ tone: 'info', text: t(col.class === 'measure' ? 'sendPreview.hide.measure' : 'sendPreview.hide.other', { column: name }) });
    const moved: string[] = [];
    for (const side of ['input', 'output'] as const) {
      preview.columns[side].forEach((c, k) => {
        if ((side !== f.side || k !== f.index) && c.hidden !== f.before[side][k]?.hidden) moved.push(t(side === 'input' ? 'sendPreview.side.input' : 'sendPreview.side.output', { column: c.header || `#${k + 1}` }));
      });
    }
    if (moved.length > 0) next.push({ tone: 'info', text: t('sendPreview.linked', { columns: moved.join(', ') }) });
    setNotes(next);
  }, [preview, t]);

  const choose = (side: Side, index: number, hidden: boolean): void => {
    if (!preview) return;
    const group = preview.columns[side][index]?.group;
    const choice: ColumnChoice = hidden ? 'hidden' : 'sent';
    // The whole copy goes together (the classification moves it anyway): every column of the group gets the same choice.
    const next = { input: { ...(columnChoices.input ?? {}) }, output: { ...(columnChoices.output ?? {}) } };
    preview.columns.input.forEach((c, k) => {
      if (c.group === group) next.input[k] = choice;
    });
    preview.columns.output.forEach((c, k) => {
      if (c.group === group) next.output[k] = choice;
    });
    next[side][index] = choice;
    flip.current = { side, index, hidden, before: preview.columns };
    session.setColumnChoices(next);
  };

  let body;
  if (!input || !output) {
    body = (
      <>
        <p>{t('sendPreview.noFiles')}</p>
        <SendBefore masking={masking} />
      </>
    );
  } else if (state.status === 'idle' || state.status === 'loading') {
    body = (
      <div className="send-preview__loading" role="status">
        <p>{t('flow.checking')}</p>
        <Progress value={state.status === 'loading' ? state.fraction : 0} label={t('flow.checking')} />
      </div>
    );
  } else if (state.status === 'failed') {
    body = <InlineMessage tone="info">{t('sendPreview.failed')}</InlineMessage>;
  } else if (state.preview.status !== 'ready') {
    body = <InlineMessage tone="info">{t(state.preview.status === 'blocked' ? 'sendPreview.blocked' : 'sendPreview.notReady')}</InlineMessage>;
  } else {
    const ready = state.preview;
    body = (
      <>
        <p>{t(masking ? 'sendPreview.lead.on' : 'sendPreview.lead.off')}</p>
        {masking ? null : (
          <InlineMessage
            tone="info"
            actions={
              <Button variant="secondary" size="sm" onClick={() => session.setMasking(true)}>
                {t('sendPreview.off.turnOn')}
              </Button>
            }
          >
            {t('sendPreview.off.note')}
          </InlineMessage>
        )}
        <div className="send-preview__notes" aria-live="polite">
          {notes.map((n, i) => (
            <InlineMessage key={i} tone={n.tone}>
              {n.text}
            </InlineMessage>
          ))}
        </div>
        <RowsTable columns={ready.columns} samples={ready.payload.samples} masking={masking} onChoose={choose} />
        {ready.payload.dropped && ready.payload.dropped.length > 0 ? <DroppedTable columns={ready.columns.input} rows={ready.payload.dropped} /> : null}
        {masking ? <p className="muted">{t('sendPreview.choicesNote')}</p> : null}
        <details className="send-preview__more">
          <summary>{t('sendPreview.json')}</summary>
          <CodeBlock label={t('sendPreview.json')} json={learnRequest(ready.payload)} />
        </details>
      </>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('sendPanel.title')} size="large">
      {body}
      {input && output ? (
        <details className="send-preview__more">
          <summary>{t('sendPreview.also')}</summary>
          <SendBefore masking={masking} />
        </details>
      ) : null}
      {sent.length > 0 ? (
        <section className="send-preview__sent" aria-labelledby={sentId}>
          <h3 id={sentId}>{t('sendPreview.sentSoFar')}</h3>
          <SentRecords sent={sent} />
        </section>
      ) : null}
    </Dialog>
  );
}

/** The sample rows as they go: input columns, then output columns, each header with its switch. A row that expands spans its output rows. */
function RowsTable({ columns, samples, masking, onChoose }: { columns: Columns; samples: readonly Sample[]; masking: boolean; onChoose(side: Side, index: number, hidden: boolean): void }) {
  const { t } = useI18n();
  const nIn = columns.input.length;
  const nOut = columns.output.length;
  const rows = samples.flatMap((s, k) => {
    const outRows: (readonly PayloadCell[])[] = s.out.length > 0 && Array.isArray(s.out[0]) ? (s.out as PayloadCell[][]) : s.out.length > 0 ? [s.out as PayloadCell[]] : [[]];
    return outRows.map((out, r) => (
      <tr key={`${k}:${r}`} className={r === 0 && k > 0 ? 'send-preview__first' : undefined}>
        {r === 0 ? s.in.map((v, i) => <ValueCell key={`i${i}`} value={v} hidden={columns.input[i]?.hidden === true} rowSpan={outRows.length} />) : null}
        {Array.from({ length: nOut }, (_, o) => (
          <ValueCell key={`o${o}`} value={out[o] ?? null} hidden={columns.output[o]?.hidden === true} outStart={o === 0} />
        ))}
      </tr>
    ));
  });
  return (
    <div className="send-preview__scroll" role="region" aria-label={t('sendPreview.table')} tabIndex={0}>
      <table className="send-preview__table">
        <thead>
          <tr>
            <th scope="colgroup" colSpan={nIn} className="send-preview__side">
              {t('sendPanel.columns.input')}
            </th>
            <th scope="colgroup" colSpan={nOut} className="send-preview__side send-preview__side--out">
              {t('sendPanel.columns.output')}
            </th>
          </tr>
          <tr>
            {columns.input.map((c, k) => (
              <ColumnHead key={`i${k}`} column={c} name={columnName(columns, 'input', k, t)} index={k} side="input" masking={masking} onChoose={onChoose} />
            ))}
            {columns.output.map((c, k) => (
              <ColumnHead key={`o${k}`} column={c} name={columnName(columns, 'output', k, t)} index={k} side="output" masking={masking} onChoose={onChoose} />
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function ValueCell({ value, hidden, rowSpan, outStart }: { value: PayloadCell; hidden: boolean; rowSpan?: number; outStart?: boolean }) {
  return (
    <td data-hidden={hidden || undefined} data-out-start={outStart || undefined} {...(rowSpan && rowSpan > 1 ? { rowSpan } : {})}>
      <Cell value={typeof value === 'boolean' ? String(value) : value} />
    </td>
  );
}

/** A column's name and its switch: a real checkbox with role="switch", named "{column}: hidden" (on: hidden, off: sent as it is). */
function ColumnHead({ column, name, index, side, masking, onChoose }: { column: SendColumn; name: string; index: number; side: Side; masking: boolean; onChoose(side: Side, index: number, hidden: boolean): void }) {
  const { t } = useI18n();
  const noteId = useId();
  const always = masking && !column.canHide;
  const disabled = !masking || always;
  return (
    <th scope="col" data-hidden={column.hidden || undefined} className={side === 'output' && index === 0 ? 'send-preview__out-start' : undefined}>
      <span className="send-preview__name">
        <Cell value={column.header || `#${index + 1}`} />
      </span>
      <label className="col-switch">
        <input
          className="switch__input"
          type="checkbox"
          role="switch"
          aria-label={t('sendPreview.switch.label', { column: name })}
          checked={column.hidden}
          disabled={disabled}
          {...(always ? { 'aria-describedby': noteId } : {})}
          onChange={(e) => onChoose(side, index, e.target.checked)}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        <span className="col-switch__state" aria-hidden="true">
          {t(column.hidden ? 'sendPreview.switch.hidden' : 'sendPreview.switch.sent')}
        </span>
      </label>
      {always ? (
        <span className="col-switch__note" id={noteId}>
          {t(column.class === 'date' ? 'sendPreview.cannotHide.date' : 'sendPreview.cannotHide.boolean')}
        </span>
      ) : null}
    </th>
  );
}

/** The input rows the example output leaves out, as they go (the payload's `dropped`). */
function DroppedTable({ columns, rows }: { columns: readonly SendColumn[]; rows: readonly (readonly PayloadCell[])[] }) {
  const { t } = useI18n();
  return (
    <div className="send-preview__scroll" role="region" aria-label={t('sendPreview.dropped')} tabIndex={0}>
      <table className="send-preview__table">
        <caption>{t('sendPreview.dropped')}</caption>
        <thead>
          <tr>
            {columns.map((c, k) => (
              <th key={k} scope="col" data-hidden={c.hidden || undefined}>
                <Cell value={c.header || `#${k + 1}`} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k}>
              {columns.map((c, i) => (
                <ValueCell key={i} value={r[i] ?? null} hidden={c.hidden} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
