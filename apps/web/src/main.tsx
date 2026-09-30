import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './app/App';
import { applyDocumentLang, I18nProvider, initialLang } from './i18n';
import { ServicesProvider } from './services';
import './styles/index.css';

// SPEC 16.2: set <html lang dir> before the first paint, from the cookie or the browser language.
const lang = initialLang();
applyDocumentLang(lang);

// A data router (the one catch-all route is the whole app, which routes inside itself): only a data router can hold back a change of
// screen, which "Unsaved changes" needs (see app/LeaveGuard.tsx).
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider initial={lang}>
      <ServicesProvider>
        <RouterProvider router={router} />
      </ServicesProvider>
    </I18nProvider>
  </StrictMode>,
);
