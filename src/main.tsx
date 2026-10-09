import React from 'react';
import { installPositionSource } from './nav/simulate';
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

/*
 * The position source multiplexer goes in before React mounts.
 *
 * `useLocation` subscribes in an effect at mount, so an override installed later sits in
 * front of a subscription that already went past it and delivers nothing. The first version
 * installed on the Settings toggle and every symptom was consistent with a simulator that
 * simply did not reach the app: the panel counted fixes, the distance readout sat frozen, and
 * nothing threw. See `src/nav/simulate.ts`.
 *
 * Installing it unconditionally is cheap — it is a passthrough to the real receiver until a
 * simulator is started — and it means no toggle has to re-subscribe anything.
 */
installPositionSource();

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