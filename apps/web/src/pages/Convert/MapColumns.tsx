// The renamed-columns step (SPEC 5 C, 8.15): a required column the file doesn't have under its usual name, and columns of the
// file that nothing claimed. The user says which is which (suggestions first); "remember this" saves each answer once, as an
// alias on the SOURCE. It is asked once per source, so it lists every format the change affects.
import type { ConversionMatch } from '@formatai/engine';
import { useId, useState } from 'react';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { FormatChips } from './FormatChips';
import { isolate, mappingOptions } from './logic';

const NONE = '__none__';

export interface MapColumnsProps {
  sourceName: string;
  /** The names of every format this source feeds (in scope): all of them are affected by the renamed column. */
  formats: readonly string[];
  match: ConversionMatch;
  onSubmit(mapping: Record<string, string | null>, remember: boolean): void;
  onCancel(): void;
}

export function MapColumns({ sourceName, formats, match, onSubmit, onCancel }: MapColumnsProps) {
  const { t } = useI18n();
  const id = useId();
  const required = match.missingRequired;
  // The best suggestion is filled in, so the common case is one click on Continue; nothing happens until then.
  const [picked, setPicked] = useState<Record<string, string>>(() => {
    const first: Record<string, string> = {};
    const taken = new Set<string>();
    for (const header of required) {
      const best = mappingOptions(match, header).suggested.find((h) => !taken.has(h));
      if (best !== undefined) {
        first[header] = best;
        taken.add(best);
      }
    }
    return first;
  });
  const [remember, setRemember] = useState(true);
  const complete = required.every((h) => picked[h] !== undefined && picked[h] !== '');

  const submit = (): void => {
    const mapping: Record<string, string | null> = {};
    for (const h of required) mapping[h] = picked[h] === NONE ? null : (picked[h] ?? null);
    onSubmit(mapping, remember);
  };

  return (
    <section className="conv__step" aria-labelledby={`${id}-title`} data-testid="map-columns">
      <h2 id={`${id}-title`}>{t('conv.map.title')}</h2>
      <p className="lead">{t(required.length === 1 ? 'conv.map.lead.one' : 'conv.map.lead.other', { source: isolate(sourceName), count: required.length })}</p>
      <FormatChips label="conv.affects" formats={formats} testId="affected-formats" />
      <div className="mapping">
        {required.map((header) => {
          const { suggested, others } = mappingOptions(match, header);
          const takenElsewhere = new Set(required.filter((h) => h !== header).map((h) => picked[h]).filter((v): v is string => !!v && v !== NONE));
          const fieldId = `${id}-${header}`;
          return (
            <div className="field mapping__row" key={header}>
              <label className="field__label" htmlFor={fieldId}>
                {t('conv.map.for', { header: isolate(header) })}
              </label>
              <select id={fieldId} className="input" value={picked[header] ?? ''} onChange={(e) => setPicked((p) => ({ ...p, [header]: e.target.value }))}>
                <option value="" disabled>
                  {t('conv.map.choose')}
                </option>
                {suggested.length > 0 ? (
                  <optgroup label={t('conv.map.suggested')}>
                    {suggested.map((h) => (
                      <option key={h} value={h} disabled={takenElsewhere.has(h)}>
                        {h}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {others.length > 0 ? (
                  <optgroup label={t('conv.map.others')}>
                    {others.map((h) => (
                      <option key={h} value={h} disabled={takenElsewhere.has(h)}>
                        {h}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <option value={NONE}>{t('conv.map.none')}</option>
              </select>
              {picked[header] && picked[header] !== NONE ? (
                <p className="field__hint">
                  <Cell value={picked[header]} /> → <Cell value={header} />
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          {t('conv.map.remember')}
          <span className="field__hint"> {t(formats.length > 1 ? 'conv.map.remember.hint.all' : 'conv.map.remember.hint', { n: formats.length })}</span>
        </span>
      </label>
      <div className="conv__actions">
        <Button variant="primary" disabled={!complete} onClick={submit}>
          {t('conv.map.continue')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('conv.tryAnother')}
        </Button>
      </div>
    </section>
  );
}
