import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Home from '../pages/Home';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { ResultPage } from '../pages/Result';
import { LearnSessionProvider, useLearnSession } from './LearnSession';
import { Shell } from './Shell';
import { SignInProvider } from './SignIn';
import { TurnstileProvider } from './Turnstile';

// The /dev debug page: dev server only (or a build made with VITE_DEV_PAGE=true, to
// check the production bundle). In every other build the condition is statically false,
// so the page and everything only it imports are dropped from the bundle.
const showDevPage = import.meta.env.DEV || import.meta.env.VITE_DEV_PAGE === 'true';
const DevPage = showDevPage ? lazy(() => import('../pages/DevPage')) : null;

/** /result: only meaningful once a learn has finished; a reload (or a typed address) goes home. */
function ResultRoute() {
  const { flow } = useLearnSession();
  if (flow.state.status !== 'done') return <Navigate to="/" replace />;
  return <ResultPage {...flow} />;
}

export function App() {
  return (
    <TurnstileProvider>
      <SignInProvider>
        <LearnSessionProvider>
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/result" element={<ResultRoute />} />
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
  );
}
