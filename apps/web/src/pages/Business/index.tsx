import { UpgradeButton } from '../../app/Upgrade';
import { useI18n, type MessageKey } from '../../i18n';
import { LeadForm } from './LeadForm';
import { Plans } from './Plans';

const HOW: readonly { title: MessageKey; text: MessageKey }[] = [
  { title: 'business.how.1.title', text: 'business.how.1.text' },
  { title: 'business.how.2.title', text: 'business.how.2.text' },
  { title: 'business.how.3.title', text: 'business.how.3.text' },
];

const DIFFERENT: readonly { title: MessageKey; text: MessageKey }[] = [
  { title: 'business.different.1.title', text: 'business.different.1.text' },
  { title: 'business.different.2.title', text: 'business.different.2.text' },
  { title: 'business.different.3.title', text: 'business.different.3.text' },
  { title: 'business.different.4.title', text: 'business.different.4.text' },
  { title: 'business.different.5.title', text: 'business.different.5.text' },
  { title: 'business.different.6.title', text: 'business.different.6.text' },
];

/**
 * For business (`/business`, SPEC 16.1 screen 7): the problem, the idea, how it works, what makes it different, the plans and a lead form.
 * The same page has to look good on a phone, so it is one column of short sections with no card grid; the plans table becomes one block per plan.
 */
export default function BusinessPage() {
  const { t } = useI18n();
  return (
    <main id="main" className="page biz" tabIndex={-1}>
      <div className="view">
        <header className="tool__head">
          <h1>{t('business.title')}</h1>
          <p className="lead">{t('business.lead')}</p>
          <p>
            <a className="btn btn--primary" href="#contact">
              {t('business.cta')}
            </a>
          </p>
        </header>

        <section className="biz__section" aria-labelledby="biz-problem">
          <h2 id="biz-problem">{t('business.problem.title')}</h2>
          <p>{t('business.problem.text')}</p>
        </section>

        <section className="biz__section" aria-labelledby="biz-idea">
          <h2 id="biz-idea">{t('business.idea.title')}</h2>
          <p>{t('business.idea.text')}</p>
        </section>

        <section className="how how--biz" aria-labelledby="biz-how">
          <h2 className="how__title" id="biz-how">
            {t('business.how.title')}
          </h2>
          <ol className="how__list">
            {HOW.map((step, i) => (
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

        <section className="biz__section" aria-labelledby="biz-different">
          <h2 id="biz-different">{t('business.different.title')}</h2>
          <ul className="biz__different">
            {DIFFERENT.map((item) => (
              <li key={item.title}>
                <h3>{t(item.title)}</h3>
                <p>{t(item.text)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="biz__section" aria-labelledby="biz-ai">
          <h2 id="biz-ai">{t('business.ai.title')}</h2>
          <p>{t('business.ai.text')}</p>
        </section>

        <section className="biz__section" aria-labelledby="biz-plans">
          <h2 id="biz-plans">{t('business.plans.title')}</h2>
          <p>{t('business.plans.lead')}</p>
          <Plans />
          <p>
            <UpgradeButton label="business.plans.waitlist" trigger="other" />
          </p>
        </section>

        <section className="biz__section biz__contact" id="contact" aria-labelledby="biz-contact">
          <h2 id="biz-contact">{t('business.contact.title')}</h2>
          <p>{t('business.contact.lead')}</p>
          <LeadForm />
        </section>
      </div>
    </main>
  );
}
