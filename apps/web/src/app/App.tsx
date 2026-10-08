import { pageNameOf } from '@formatai/shared';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import AddSourcePage from '../pages/AddSource';
import BusinessPage from '../pages/Business';
import ConvertPage from '../pages/Convert';
import FormatPage from '../pages/Format';
import EditSourcePage from '../pages/Format/EditSource';
import FormatsPage from '../pages/Formats';
import Home from '../pages/Home';
import { useI18n } from '../i18n';
import { LegalPage } from '../pages/Legal/LegalPage';
import { ResultPage } from '../pages/Result';
import { peekResultSession } from '../pages/Result/session';
import { useTrack } from '../services';
import { Spinner } from '../ui';
import { AiLimitProvider } from './AiLimit';
import { FeaturesProvider } from './Features';
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

// The admin view (SPEC 14.2): its own chunk - only an admin ever opens it.
const AdminPage = lazy(() => import('../pages/Admin'));

/**
 * /result: only meaningful once a learn has finished; a reload (or a typed address) goes home. Coming back from a sign-in it waits for
 * the kept learn to be put back (SPEC 5 E) instead of going home.
 *
 * A learn that has been saved keeps this screen at its source's own address, /formats/:id/sources/:conversionId (the example files are
 * still in the worker, so the live check goes on); any other visit to that address - a reload, a link - is the saved-source editor. Both
 * routes render this one component, so moving from one to the other after the save does not rebuild the screen.
 */
function ResultRoute() {
  const { flow, restoring } = useLearnSession();
  const { t } = useI18n();
  const { id, conversionId } = useParams();
  if (conversionId !== undefined) {
    const kept = flow.state.status === 'done' && flow.state.result.rules ? peekResultSession(flow.state.result) : undefined;
    if (kept?.source?.conversionId === conversionId && kept.source.formatId === id) return <ResultPage {...flow} />;
    return <EditSourcePage />;
  }
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

/**
 * `page_view {page}` (SPEC 14.1): one event each time the address changes, with the route's NAME (home, learn, formats, format, convert, ...) -
 * never the path or the query, which can carry a format's id. Renders nothing.
 */
function PageViews() {
  const { pathname } = useLocation();
  const track = useTrack();
  // (the same address twice in a row is one view: React's development double-run of effects must not count a page twice)
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    track('page_view', { page: pageNameOf(pathname) });
  }, [pathname, track]);
  return null;
}

/** /batch was the paid-only batch page: batch is part of the Run screen now (SPEC 21 v11), so old links land there, query string and all (`?format=`). */
function BatchRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/convert', search }} replace />;
}

export function App() {
  return (
    <MeProvider>
      <FeaturesProvider>
        <TurnstileProvider>
          <SignInProvider>
            <LearnSessionProvider>
              <AiLimitProvider>
                <Shell>
                  <PageViews />
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/result" element={<ResultRoute />} />
                    <Route path="/formats" element={<FormatsPage />} />
                    <Route path="/formats/:id" element={<FormatPage />} />
                    <Route path="/formats/:id/add-source" element={<AddSourcePage />} />
                    <Route path="/formats/:id/sources/:conversionId" element={<ResultRoute />} />
                    <Route path="/convert" element={<ConvertPage />} />
                    <Route path="/batch" element={<BatchRedirect />} />
                    <Route
                      path="/admin"
                      element={
                        <Suspense fallback={null}>
                          <AdminPage />
                        </Suspense>
                      }
                    />
                    <Route path="/business" element={<BusinessPage />} />
                    {/* v13 M4: the legal pages (drafts: the owner or a lawyer reviews them - see i18n/legal.ts) and the accessibility statement. */}
                    <Route path="/privacy" element={<LegalPage id="privacy" />} />
                    <Route path="/terms" element={<LegalPage id="terms" />} />
                    <Route path="/accessibility" element={<LegalPage id="accessibility" />} />
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
              </AiLimitProvider>
            </LearnSessionProvider>
          </SignInProvider>
        </TurnstileProvider>
      </FeaturesProvider>
    </MeProvider>
  );
}
