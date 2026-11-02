import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider, createI18n, initialLocale, switchLocale } from './lib/i18n';
import { takeInviteLanguage } from './lib/router';
import { ToastProvider } from './components/ui';
import './styles.css';

// Read an invitation's `lang` once (and drop it from the address bar), then
// load that language before the first render so the join screen never
// flashes in another language.
const inviteLocale = takeInviteLanguage();
const i18n = createI18n();
const first = initialLocale(inviteLocale);
document.documentElement.lang = first;
void switchLocale(i18n, first).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider instance={i18n} inviteLocale={inviteLocale}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nProvider>
    </StrictMode>,
  );
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
