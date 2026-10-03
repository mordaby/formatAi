// "This file feeds N formats" (SPEC 5 C, 8.15): the source the file matched feeds several formats, so the user picks which of
// them to make - all are pre-checked, with an "All" toggle. Each chosen format is then converted on its own, with its own review
// of flagged rows before its file is written.
import type { SignatureEntry } from '@formatai/shared';
import { useId, useState } from 'react';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { isolate } from './logic';

export interface ChooseFormatsProps {
  source: SignatureEntry;
  onContinue(conversionIds: string[]): void;
  onCancel(): void;
}

export function ChooseFormats({ source, onContinue, onCancel }: ChooseFormatsProps) {
  const { t, lang } = useI18n();
  const id = useId();
  const nf = new Intl.NumberFormat(lang);
  const all = source.conversions.map((c) => c.conversionId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(all));
  const allPicked = picked.size === all.length;
  const toggle = (conversionId: string): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(conversionId)) next.delete(conversionId);
      else next.add(conversionId);
      return next;
    });

  return (
    <section className="conv__step" aria-labelledby={`${id}-title`} data-testid="choose-formats">
      <h2 id={`${id}-title`}>{t('conv.formats.title', { n: nf.format(all.length) })}</h2>
      <p className="lead">{t('conv.formats.lead', { source: isolate(source.name) })}</p>
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
          {source.conversions.map((c) => (
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
      <div className="conv__actions">
        <Button variant="primary" disabled={picked.size === 0} onClick={() => onContinue(all.filter((x) => picked.has(x)))}>
          {t('conv.formats.continue')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('conv.tryAnother')}
        </Button>
      </div>
      {picked.size === 0 ? <p className="muted">{t('conv.formats.none')}</p> : null}
    </section>
  );
}
