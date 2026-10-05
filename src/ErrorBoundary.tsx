/**
 * Top-level error boundary.
 *
 * Without this, any throw during render unmounts the whole tree and the user is
 * left staring at the `index.html` background — which in a car is worse than an
 * error, because there is no longer anything on screen to say what happened.
 *
 * Two things it deliberately does:
 *
 *  - **It does not swallow.** The error is logged with its component stack and
 *    re-surfaced through `onError`, so a real crash is still visible in the
 *    console and to anything attached to the boundary.
 *  - **It offers a way out.** Recovery is a re-render from a fresh key, which
 *    discards the crashed subtree's state. For the common case here — a bad
 *    route or a bad imported dataset poisoning a `useMemo` — that is enough,
 *    because the offending state lives in a child, not in the boundary's parent.
 *
 * The reset button is the primary action because the alternative, reloading the
 * page, throws away an imported map that took minutes to parse.
 */

import React from 'react';
import { ink, type as T } from './theme';

/** Reported once per caught error so a host can log or forward it. */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Notified with the error and its component stack. Defaults to `console.error`
   * so an uncaught error is never silently swallowed.
   */
  onError?: (error: unknown, info: React.ErrorInfo) => void;
  /** Rendered instead of the default recovery card. */
  fallback?: (error: unknown, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
  /** Bumped to remount the subtree after a reset. */
  generation: number;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, generation: 0 };

  static getDerivedStateFromError(error: unknown): Pick<ErrorBoundaryState, 'error'> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // `console.error` rather than nothing: React already logs this too, but a
    // boundary that swallows is indistinguishable from a boundary that works.
    const report = this.props.onError ?? ((e, i) => console.error('[canopy] uncaught render error', e, i));
    report(error, info);
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  override render(): React.ReactNode {
    const { error, generation } = this.state;
    if (error === null) {
      // The key is what makes "try again" actually discard the broken subtree
      // rather than re-rendering the same instance with the same bad state.
      return <React.Fragment key={generation}>{this.props.children}</React.Fragment>;
    }
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <CrashCard error={error} onReset={this.reset} />;
  }
}

/**
 * Best-effort text for whatever was thrown.
 *
 * `String(error)` is the obvious version and it is wrong twice: a thrown
 * `undefined` or `null` renders the literal words "undefined"/"null" on the
 * crash screen, and a thrown object renders "[object Object]". Both are worse
 * than admitting nothing was recognised. A circular object also makes
 * `JSON.stringify` throw, which on an error path is the last place that should
 * raise a second error.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return 'Unknown error';
  try {
    const json = JSON.stringify(error);
    return json && json !== '{}' ? json : String(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * What the user actually sees. Deliberately plain and legible at a glance.
 *
 * Exported so its markup can be asserted directly. There is no DOM in this
 * project's test environment, and React's server renderer re-throws rather than
 * honouring a boundary — so this is the only way to pin what the crash screen
 * actually says.
 */
export function CrashCard({ error, onReset }: { error: unknown; onReset: () => void }) {
  const message = describeError(error);
  return (
    <div
      className="crash-card"
      role="alert"
      // Safe-area aware so it clears a display cutout on a phone.
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        background: '#0E1013',
        color: ink.primary,
        textAlign: 'center',
        zIndex: 9999,
      }}
    >
      <div style={T.display3}>Canopy Nav stopped</div>
      <div style={{ ...T.body2, color: ink.secondary, maxWidth: 480 }}>
        Something went wrong on this screen. Your imported maps are still saved.
      </div>
      <div
        style={{
          ...T.sub3,
          // A stack trace or an OSM parser message is code, not copy, so it gets
          // a monospace face even though the scale is a UI one.
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: ink.tertiary,
          maxWidth: 480,
          overflowWrap: 'anywhere',
          padding: '8px 12px',
          border: `1px solid ${ink.outline}`,
          borderRadius: 8,
        }}
      >
        {message}
      </div>
      <button type="button" className="primary-btn" onClick={onReset} style={{ minHeight: 76, minWidth: 200 }}>
        Try again
      </button>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          ...T.body2,
          color: ink.secondary,
          background: 'none',
          border: 'none',
          minHeight: 76,
          padding: '0 16px',
          cursor: 'pointer',
        }}
      >
        Reload the app
      </button>
    </div>
  );
}

/**
 * Failures that happen outside React's tree.
 *
 * A rejected promise or a thrown error in an async callback never reaches a
 * boundary, so on its own it produces a console line and no user-visible change
 * at all. These are reported rather than handled — the app's own loaders own
 * their failures and show specific messages — but routing them through one
 * console prefix is what makes them findable in a WebView logcat.
 */
export function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;
  const key = '__canopyErrorReporting';
  if ((window as any)[key]) return;
  (window as any)[key] = true;

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[canopy] unhandled rejection:', e.reason);
  });
  window.addEventListener('error', (e) => {
    // Resource load failures (a failed tile, a blocked request) surface here as
    // ErrorEvent with no `error` object. They are noise, not faults.
    if (!e.error) return;
    console.error('[canopy] uncaught error:', e.error);
  });
}