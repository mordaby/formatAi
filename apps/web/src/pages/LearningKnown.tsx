// "You already have this format" (owner decision 2026-10-07, SPEC 5 A step 2a): the user's saved rules already make this example exactly, so
// nothing was learned - no AI format spent, nothing saved. Not an error: one clear message and two ways on. Neutral wording: a format, never a
// source (the source-related UI may be switched off).
//   Convert files with it - the Run screen of that format, with the example input already dropped.
//   Learn again anyway    - the learn the user asked for, without this check.
import type { KnownPair } from '@formatai/engine';
import { useI18n } from '../i18n';
import { Button } from '../ui';
import { Marked } from './Result/Named';

export interface LearningKnownProps {
  known: KnownPair;
  onConvert(): void;
  onLearnAnyway(): void;
}

export function LearningKnown({ known, onConvert, onLearnAnyway }: LearningKnownProps) {
  const { t } = useI18n();
  return (
    <div className="view preflight" data-testid="learning-known">
      <header className="tool__head">
        <h1>{t('known.title')}</h1>
        <p className="lead">
          <Marked
            id="known.text"
            nodes={{
              format: (
                <strong>
                  <bdi>{known.formatName}</bdi>
                </strong>
              ),
            }}
          />
        </p>
      </header>
      <div className="preflight__actions">
        <Button variant="primary" iconEnd="arrow" onClick={onConvert}>
          {t('known.convert')}
        </Button>
        <Button variant="secondary" onClick={onLearnAnyway}>
          {t('known.again')}
        </Button>
      </div>
    </div>
  );
}
