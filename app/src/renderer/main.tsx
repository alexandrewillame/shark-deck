import React from 'react';
import { createRoot } from 'react-dom/client';
import { getT } from '@shared/i18n';
import './styles.css';
import { App } from './App';
import { I18nProvider } from './state/i18n';
import { useStore } from './state/store';

/** The toast for an error nothing else caught. Outside React, so the language
 *  is read from the store at the moment it fires rather than through `useT`. */
const unexpected = (error: string) => {
  const s = useStore.getState();
  s.toast('err', getT(s.settings?.language ?? 'en')('err.unexpected', { error }));
};

/**
 * The browser's own notice that a ResizeObserver could not deliver every
 * notification within one frame. Nothing threw (`e.error` is null) and the
 * rest arrive on the next frame, so it is logged, not toasted: an "Unexpected
 * error" toast for it alarmed users over nothing. The observer that raised it
 * is still a bug to fix (as ArtAnchor's was), which is what the console line
 * is for. Chromium's wording; older builds said "limit exceeded".
 */
const isResizeObserverNotice = (e: ErrorEvent) =>
  !e.error &&
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(e.message);

/**
 * Last-resort net for errors `ErrorBoundary` can't see — a throw outside
 * React's render (an event handler, a `.then()` callback, a timer) doesn't
 * trigger a boundary at all. These can't be "recovered" the way a render
 * throw can, but logging + a toast beats silent failure, and neither of
 * these tears down the window the way an uncaught render exception used to.
 */
window.addEventListener('error', (e) => {
  if (isResizeObserverNotice(e)) {
    // eslint-disable-next-line no-console
    console.warn('SharkDeck renderer:', e.message);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('SharkDeck renderer error (window.onerror):', e.error ?? e.message);
  unexpected(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('SharkDeck renderer unhandled rejection:', e.reason);
  unexpected(e.reason instanceof Error ? e.reason.message : String(e.reason));
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
