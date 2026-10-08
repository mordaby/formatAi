// "This file feeds N formats" (SPEC 5 C, 8.15): the source the file matched feeds several formats, so the user picks which of
// them to make - none is pre-checked when there are several to choose from, with an "All" toggle. Each chosen format is then converted on its own, with its own review
// of flagged rows before its file is written.
//
// DECISION (owner, 2026-10-08): with several ready formats nothing is pre-checked. Two senders can use the same column names for different
// things, so the formats of the file's source may include one learned from a file that only looks like this one; no check can tell every
// such case apart, so each format made is one the user ticked ("All" is one click when they really want every one). A single ready format
// (the others need attention) is pre-checked: there is nothing to choose between, as for a source with one format, which runs at once.
//
// When this file cannot be made into some of the formats as it is (a column they use is not in it, SPEC 21 v11 items 4-7), those are listed under
// "Needs attention" with why, and the user decides each one: open its editor, skip it this time, or - when it can still run - make it
// anyway. The formats that work are never held back by the others.
import type { SourceConversionRef, SignatureEntry } from '@formatai/shared';
import { useId, useState } from 'react';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { runAnywayLabel, willRunText } from './attention';
import { isolate } from './logic';
import { AttentionList, AttentionRow } from './NeedsAttention';
import type { AttentionFormat, FormatChoice } from './useConvertFlow';

export interface ChooseFormatsProps {
  source: SignatureEntry;
  /** The formats this file can be made into as it is. */
  ready: readonly SourceConversionRef[];
  /** The formats that need a look first, and why (none: every format of the source is ready). */
  attention?: readonly AttentionFormat[];
  onContinue(choice: FormatChoice): void;
  /** "Open in editor" on a format that needs attention. */
  onEdit(format: { conversionId: string; formatId: string }): void;
  onCancel(): void;
}

export function ChooseFormats({ source, ready, attention = [], onContinue, onEdit, onCancel }: ChooseFormatsProps) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const id = useId();
  const nf = new Intl.NumberFormat(lang);
  const all = ready.map((c) => c.conversionId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(all.length === 1 ? all : []));
  // What the user decided about the formats that need attention: make them anyway, or skip them this time.
  const [anyway, setAnyway] = useState<ReadonlySet<string>>(() => new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const allPicked = picked.size === all.length;
  const makes = picked.size + anyway.size;
  const toggle = (conversionId: string): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(conversionId)) next.delete(conversionId);
      else next.add(conversionId);
      return next;
    });
  const decide = (set: ReadonlySet<string>, conversionId: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(conversionId);
    else next.delete(conversionId);
    return next;
  };

  return (
    <section className="conv__step" aria-labelledby={`${id}-title`} data-testid="choose-formats">
      <h2 id={`${id}-title`}>{attention.length === 0 ? t('conv.formats.title', { n: nf.format(all.length) }) : t(ready.length > 0 ? 'conv.attention.title' : 'conv.attention.title.none')}</h2>
      <p className="lead">
        {attention.length === 0
          ? t('conv.formats.lead', { source: isolate(source.name) })
          : t(ready.length > 0 ? 'conv.attention.lead' : 'conv.attention.lead.none', { source: isolate(source.name) })}
      </p>
      {ready.length > 0 ? (
        <fieldset className="fmts">
          <legend className="visually-hidden">{t('conv.formats.legend')}</legend>
          <label className="check fmts__all">
            <input
              type="checkbox"
              checked={allPicked}
              // Some but not all: the browser draws the box as "partly".
              ref={(el) => {
                if (el) el.indeterminate = picked.size > 0 && !allPicked;
              }}
              onChange={() => setPicked(allPicked ? new Set() : new Set(all))}
            />
            <span>{t('conv.formats.all')}</span>
          </label>
          <ul className="fmts__list">
            {ready.map((c) => (
              <li key={c.conversionId}>
                <label className="check">
                  <input type="checkbox" checked={picked.has(c.conversionId)} onChange={() => toggle(c.conversionId)} />
                  <span>
                    <Cell value={c.formatName} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {attention.length > 0 ? (
        <>
          <AttentionList>
            {attention.map((a) => {
              const label = runAnywayLabel(i18n, a.attention);
              return (
                <AttentionRow key={a.conversionId} formatName={a.formatName} attention={a.attention}>
                  {anyway.has(a.conversionId) ? (
                    <>
                      <span className="muted">{willRunText(i18n, a.attention)}</span>
                      <Button variant="ghost" size="sm" onClick={() => setAnyway((s) => decide(s, a.conversionId, false))}>
                        {t('conv.review.undo')}
                      </Button>
                    </>
                  ) : skipped.has(a.conversionId) ? (
                    <>
                      <span className="muted">{t('conv.attention.skipped')}</span>
                      <Button variant="ghost" size="sm" onClick={() => setSkipped((s) => decide(s, a.conversionId, false))}>
                        {t('conv.review.undo')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => onEdit(a)}>
                        {t('conv.attention.edit')}
                      </Button>
                      {label ? (
                        <Button variant="secondary" size="sm" onClick={() => setAnyway((s) => decide(s, a.conversionId, true))}>
                          {label}
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => setSkipped((s) => decide(s, a.conversionId, true))}>
                        {t('conv.attention.skip')}
                      </Button>
                    </>
                  )}
                </AttentionRow>
              );
            })}
          </AttentionList>
          <p className="muted">{t('conv.attention.hint')}</p>
        </>
      ) : null}
      <div className="conv__actions">
        <Button
          variant="primary"
          disabled={makes === 0}
          onClick={() => onContinue({ run: all.filter((x) => picked.has(x)), anyway: attention.filter((a) => anyway.has(a.conversionId)).map((a) => a.conversionId), skipped: attention.filter((a) => skipped.has(a.conversionId)).map((a) => a.conversionId) })}
        >
          {t('conv.formats.continue')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('conv.tryAnother')}
        </Button>
      </div>
      {makes === 0 && ready.length > 0 ? <p className="muted">{t('conv.formats.none')}</p> : null}
    </section>
  );
}
