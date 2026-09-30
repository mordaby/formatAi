import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { LanguageToggle } from './components/LanguageToggle';
import { useI18n } from './i18n';

// The /dev debug page: dev server only (or a build made with VITE_DEV_PAGE=true, to
// check the production bundle). In every other build the condition is statically false,
// so the page and everything only it imports are dropped from the bundle.
const showDevPage = import.meta.env.DEV || import.meta.env.VITE_DEV_PAGE === 'true';
const DevPage = showDevPage ? lazy(() => import('./pages/DevPage')) : null;

function Home() {
  const { t } = useI18n();
  return (
    <main>
      <h1>{t('app.name')}</h1>
      <p>{t('app.tagline')}</p>
      <p>{t('masking.always')}</p>
    </main>
  );
}

export function App() {
  const { t } = useI18n();
  return (
    <>
      <header>
        <Link to="/">{t('app.name')}</Link> <LanguageToggle />
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        {DevPage && (
          <Route
            path="/dev"
            element={
              <Suspense fallback={null}>
                <DevPage />
              </Suspense>
            }
          />
        )}
        <Route path="*" element={<Home />} />
      </Routes>
    </>
  );
}
