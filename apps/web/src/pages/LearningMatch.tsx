// "This output matches your format" (owner decision 2026-10-07, SPEC 5 A step 2): the example's output is one of the user's formats, and its
// input is not one that format takes yet - asked ONCE, at Learn, before anything is learned (no AI call, nothing counted). A format is the
// output; each kind of input file has its own rules (kept as a "source" behind the scenes - never said here).
//   Yes, learn it for X  - the learn against that format (its output side locked; the free engine first, "Finish with AI" on a click), and
//                          Save adds the file as another input of it, with no further question.
//   No, make a new format - the learn of a format of its own (Save creates a new format, as ever).
//   Choose other files   - back to an empty form.
// Several formats: a radio list, most recently used first (the first chosen); the answers follow the one chosen. A format that already takes
// as many input files as the plan allows (11 "Sources per format", the API's own count) says so, with the upgrade, and offers only a new format.
import type { OutputMatch } from '@formatai/engine';
import { canAddSource, type Tier } from '@formatai/shared';
import { useId, useState, type ReactNode } from 'react';
import { UpgradeButton } from '../app/Upgrade';
import { useI18n } from '../i18n';
import { Button } from '../ui';
import { Marked } from './Result/Named';

export interface LearningMatchProps {
  matches: readonly OutputMatch[];
  /** The signed-in user's plan: its number of input files per format. */
  tier: Tier;
  onYes(match: OutputMatch): void;
  onNo(): void;
  onChooseOther(): void;
}

export function LearningMatch({ matches, tier, onYes, onNo, onChooseOther }: LearningMatchProps) {
  const { t, lang } = useI18n();
  const groupId = useId();
  const [selected, setSelected] = useState(0);
  const match = matches[Math.min(selected, matches.length - 1)]!;
  const full = (m: OutputMatch): boolean => !canAddSource(tier, m.sources);
  const atLimit = full(match);
  const name = (text: string): ReactNode => (
    <strong>
      <bdi>{text}</bdi>
    </strong>
  );
  const count = (n: number): ReactNode => <span className="tabular">{n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}</span>;

  return (
    <div className="view preflight" data-testid="learning-match">
      <header className="tool__head">
        <h1>{t('sameOutput.title')}</h1>
        {matches.length === 1 ? (
          <p className="lead" data-testid="learning-match-question">
            <Marked id="sameOutput.text" nodes={{ format: name(match.formatName) }} />
          </p>
        ) : null}
      </header>
      {matches.length > 1 ? (
        <fieldset className="choices format-match__list" data-testid="learning-match-question">
          <legend>{t('sameOutput.several', { n: matches.length })}</legend>
          {matches.map((m, i) => {
            const id = `${groupId}-${i}`;
            return (
              <div className="format-match__option" key={m.formatId} data-format={m.formatId} data-full={full(m) ? 'true' : undefined}>
                <input id={id} className="choice__input" type="radio" name={groupId} checked={i === selected} onChange={() => setSelected(i)} aria-describedby={full(m) ? `${id}-what` : undefined} />
                <label htmlFor={id}>
                  <bdi>{m.formatName}</bdi>
                </label>
                {full(m) ? (
                  <span id={`${id}-what`} className="muted format-match__what">
                    {t('sameOutput.option.limit', { n: m.sources })}
                  </span>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
      {atLimit ? (
        <div className="format-match__limit" data-testid="learning-match-limit">
          <p>
            <Marked id="sameOutput.limit" nodes={{ format: name(match.formatName), n: count(match.sources) }} />
          </p>
          <UpgradeButton variant="link" trigger="sourcesPerFormat" />
        </div>
      ) : null}
      <div className="preflight__actions">
        {atLimit ? (
          <Button variant="primary" onClick={onNo}>
            {t('sameOutput.new')}
          </Button>
        ) : (
          <>
            <Button variant="primary" iconEnd="arrow" onClick={() => onYes(match)}>
              {t('sameOutput.yes', { format: match.formatName })}
            </Button>
            <Button variant="secondary" onClick={onNo}>
              {t('sameOutput.no')}
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={onChooseOther}>
          {t('sameOutput.other')}
        </Button>
      </div>
    </div>
  );
}
