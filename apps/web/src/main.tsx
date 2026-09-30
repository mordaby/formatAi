import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyDocumentLang, I18nProvider, initialLang } from './i18n';
import { ServicesProvider } from './services';

// SPEC 16.2: set <html lang dir> before the first paint, from the cookie or the browser language.
const lang = initialLang();
applyDocumentLang(lang);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider initial={lang}>
      <ServicesProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ServicesProvider>
    </I18nProvider>
  </StrictMode>,
);
