// "Which source is this file?" (SPEC 5 C, 8.12): several sources fit and none clearly wins, so the user picks from the
// top matches. Never a guess below the threshold (DECISION 10). The score is said in words, with the percentage beside it.
import type { ConversionMatch } from '@formatai/engine';
import type { SignatureEntry } from '@formatai/shared';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import { matchWords } from './logic';

export interface ChooseSourceProps {
  options: readonly ConversionMatch[];
  entries: readonly SignatureEntry[];
  onChoose(conversionId: string): void;
}

export function ChooseSource({ options, entries, onChoose }: ChooseSourceProps) {
  const { t, lang } = useI18n();
  const nf = new Intl.NumberFormat(lang);
  return (
    <section className="conv__step" aria-labelledby="conv-choose-title" data-testid="choose-source">
      <h2 id="conv-choose-title">{t('conv.choose.title')}</h2>
      <p className="lead">{t('conv.choose.lead')}</p>
      <ul className="srcs">
        {options.map((m) => {
          const entry = entries.find((e) => e.conversionId === m.id);
          return (
            <li key={m.id} className="src" data-testid="source-option">
              <div className="src__main">
                <p className="src__name">
                  <Cell value={entry?.formatName} />
                  {entry?.formatName ? (
                    <span className="src__arrow" aria-hidden="true">
                      {' ← '}
                    </span>
                  ) : null}
                  <Cell value={m.name} />
                </p>
                <p className="src__why">
                  {t(matchWords(m.score))}
                  <span className="muted"> · {t('conv.match.percent', { n: nf.format(Math.round(m.score * 100)) })}</span>
                </p>
                {m.missingRequired.length > 0 ? (
                  <div className="src__missing">
                    <span className="muted">{t('conv.match.missing')}</span>
                    <ul className="chips" aria-label={t('conv.match.missing')}>
                      {m.missingRequired.map((h) => (
                        <li key={h}>
                          <Cell value={h} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <Button variant="secondary" onClick={() => onChoose(m.id)} iconEnd="arrow">
                {t('conv.choose.pick')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
