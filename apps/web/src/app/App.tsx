import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AddSourcePage from '../pages/AddSource';
import BatchPage from '../pages/Batch';
import ConvertPage from '../pages/Convert';
import FormatPage from '../pages/Format';
import EditSourcePage from '../pages/Format/EditSource';
import FormatsPage from '../pages/Formats';
import Home from '../pages/Home';
import { useI18n } from '../i18n';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { ResultPage } from '../pages/Result';
import { Spinner } from '../ui';
import { LearnSessionProvider, useLearnSession } from './LearnSession';
import { MeProvider } from './Me';
import { Shell } from './Shell';
import { SignInProvider } from './SignIn';
import { TurnstileProvider } from './Turnstile';

// The /dev debug page: dev server only (or a build made with VITE_DEV_PAGE=true, to
// check the production bundle). In every other build the condition is statically false,
// so the page and everything only it imports are dropped from the bundle.
const showDevPage = import.meta.env.DEV || import.meta.env.VITE_DEV_PAGE === 'true';
const DevPage = showDevPage ? lazy(() => import('../pages/DevPage')) : null;

/**
 * /result: only meaningful once a learn has finished; a reload (or a typed address) goes home. Coming back from a sign-in it waits for
 * the kept learn to be put back (SPEC 5 E) instead of going home.
 */
function ResultRoute() {
  const { flow, restoring } = useLearnSession();
  const { t } = useI18n();
  // (also when the learn has finished: the kept edits are put on top of it first, so the screen never starts from the wrong ones)
  if (restoring) {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <p className="muted" role="status">
          <Spinner size={14} /> {t('learning.title')}
        </p>
      </main>
    );
  }
  if (flow.state.status !== 'done') return <Navigate to="/" replace />;
  return <ResultPage {...flow} />;
}

export function App() {
  return (
    <MeProvider>
      <TurnstileProvider>
        <SignInProvider>
          <LearnSessionProvider>
            <Shell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/result" element={<ResultRoute />} />
                <Route path="/formats" element={<FormatsPage />} />
                <Route path="/formats/:id" element={<FormatPage />} />
                <Route path="/formats/:id/add-source" element={<AddSourcePage />} />
                <Route path="/formats/:id/sources/:conversionId" element={<EditSourcePage />} />
                <Route path="/convert" element={<ConvertPage />} />
                <Route path="/batch" element={<BatchPage />} />
                <Route path="/business" element={<PlaceholderPage title="footer.business" />} />
                <Route path="/privacy" element={<PlaceholderPage title="footer.privacy" />} />
                <Route path="/terms" element={<PlaceholderPage title="footer.terms" />} />
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
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Shell>
          </LearnSessionProvider>
        </SignInProvider>
      </TurnstileProvider>
    </MeProvider>
  );
}
