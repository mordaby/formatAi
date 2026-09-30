import { useI18n, type MessageKey } from '../i18n';

const STEPS: readonly { title: MessageKey; text: MessageKey }[] = [
  { title: 'home.how.1.title', text: 'home.how.1.text' },
  { title: 'home.how.2.title', text: 'home.how.2.text' },
  { title: 'home.how.3.title', text: 'home.how.3.text' },
];

/** Below the tool: learn once, use every month. Three short lines, no card grid. */
export function HomeHowItWorks() {
  const { t } = useI18n();
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 className="how__title" id="how-title">
        {t('home.how.title')}
      </h2>
      <ol className="how__list">
        {STEPS.map((step, i) => (
          <li className="how__item" key={step.title}>
            <span className="how__n" aria-hidden="true">
              {i + 1}
            </span>
            <h3>{t(step.title)}</h3>
            <p>{t(step.text)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
