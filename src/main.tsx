import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary, installGlobalErrorReporting } from './ErrorBoundary';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

installGlobalErrorReporting();

/**
 * Register the offline shell worker.
 *
 * Without it a cold start with no network never reaches the app: the browser
 * serves its own disconnected page, which is the common case in a tunnel rather
 * than an edge case. Registration is deliberately fire-and-forget and cannot
 * block or fail the render — a WebView that refuses service workers still gets a
 * working app online.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // A plain path, not `new URL('./sw.ts', import.meta.url)`: the worker is a
    // separate build entry emitted at a stable `sw.js`, and the URL here has to
    // match it exactly for the registration to take.
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url, { type: 'module', scope: import.meta.env.BASE_URL }).catch((e) => {
      // Reported, not thrown: an unavailable worker is a degraded capability, not
      // a broken app.
      console.warn('[canopy] offline shell unavailable:', e);
    });
  });
}

createRoot(el).render(
  <React.StrictMode>
    {/* Above StrictMode on purpose: a boundary inside StrictMode still lets
        the dev-only double-invoke run, and this is the last thing standing
        between a render throw and a blank screen in the release WebView. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);