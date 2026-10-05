import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary, installGlobalErrorReporting } from './ErrorBoundary';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

installGlobalErrorReporting();

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