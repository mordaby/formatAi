import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../i18n';

/** A page that does not exist yet (Business, Privacy, Terms): a title and a way back. */
export function PlaceholderPage({ title }: { title: MessageKey }) {
  const { t } = useI18n();
  return (
    <main id="main" className="page" tabIndex={-1}>
      <section className="tool">
        <div className="view">
          <header className="tool__head">
            <h1>{t(title)}</h1>
            <p className="lead">{t('page.comingSoon')}</p>
          </header>
          <p>
            <Link to="/">{t('page.backHome')}</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
