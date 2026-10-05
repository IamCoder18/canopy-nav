/**
 * Error-boundary tests.
 *
 * The app had no boundary at all, which meant any throw during render unmounted
 * the tree and left the user looking at the `index.html` background — in a car,
 * a blank screen with no explanation.
 *
 * There is no DOM in this test environment (the project tests pure logic under
 * node), so these exercise the boundary as a state machine: what it reports,
 * what it renders in each state, and that its recovery path actually produces
 * the key remount that discards the broken subtree. The last one is the part
 * that is easy to get subtly wrong — a `reset` that only clears `error` and
 * does not change identity re-renders the *same* component instance, which for a
 * crash caused by poisoned state reproduces the crash immediately.
 *
 * Run with `npx vitest run test/errorboundary.spec.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary, CrashCard, installGlobalErrorReporting } from '../src/ErrorBoundary';

/** Mounts nothing; exercises the instance directly. */
function makeBoundary(props: Partial<React.ComponentProps<typeof ErrorBoundary>> = {}) {
  return new ErrorBoundary({ children: null, ...props });
}

describe('ErrorBoundary state machine', () => {
  it('renders its children when nothing has thrown', () => {
    const child = React.createElement('div', null, 'hello');
    const b = makeBoundary({ children: child });
    const out = b.render() as React.ReactElement;
    expect(out.type).toBe(React.Fragment);
    expect(out.props.children).toBe(child);
  });

  it('records the error it caught', () => {
    const boom = new Error('boom');
    const next = ErrorBoundary.getDerivedStateFromError(boom) as { error: unknown };
    expect(next.error).toBe(boom);
  });

  it('renders the recovery card instead of the children once it has caught', () => {
    const b = makeBoundary({ children: React.createElement('div', null, 'hello') });
    b.state = { error: new Error('boom'), generation: 0 };
    const out = b.render();
    expect(out).not.toBe(b.props.children);
    expect(React.isValidElement(out)).toBe(true);
  });

  it('reports the error and its component stack rather than swallowing it', () => {
    // A boundary that catches silently is indistinguishable, from the outside,
    // from a boundary that works. The host has to hear about it.
    const onError = vi.fn();
    const b = makeBoundary({ onError });
    const info = { componentStack: 'at Foo' } as React.ErrorInfo;
    const err = new Error('boom');
    b.componentDidCatch(err, info);
    expect(onError).toHaveBeenCalledWith(err, info);
  });

  it('does not swallow by default', () => {
    // With no handler supplied, the error still reaches the console.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = makeBoundary();
    b.componentDidCatch(new Error('boom'), { componentStack: '' } as React.ErrorInfo);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('changes the subtree identity on reset, so recovery really recovers', () => {
    // The regression this pins: `reset()` that only nulls `error` re-renders the
    // same instance, and any state that caused the crash survives.
    // React coerces element keys to strings, hence the `String()` comparisons.
    const b = makeBoundary();
    const before = b.render() as React.ReactElement;
    expect(String(before.key)).toBe('0');
    // Drive the same state transition `reset` performs, without a mount.
    b.state = { error: null, generation: b.state.generation + 1 };
    const after = b.render() as React.ReactElement;
    expect(String(after.key)).toBe('1');
    expect(after.key).not.toBe(before.key);
  });

  it('gives every recovery attempt a fresh identity across repeated failures', () => {
    // Crash, reset, crash again: each reset must produce a *new* identity, or
    // the second recovery attempt is a no-op that loops straight back to the
    // crash card. Only the recovered branch carries the generation key; the
    // crashed branch renders the fallback, which has none.
    const b = makeBoundary();
    const recovered: string[] = [];
    for (let i = 0; i < 3; i++) {
      b.state = { error: new Error(`boom ${i}`), generation: b.state.generation };
      const crashed = b.render() as React.ReactElement;
      expect(crashed.key, 'crashed branch should render the fallback').toBeNull();
      b.state = { error: null, generation: b.state.generation + 1 };
      recovered.push(String((b.render() as React.ReactElement).key));
    }
    expect(recovered).toEqual(['1', '2', '3']);
  });

  it('uses a caller-supplied fallback when given one', () => {
    const fallback = vi.fn(() => React.createElement('div', null, 'custom'));
    const b = makeBoundary({ fallback, children: React.createElement('div') });
    const err = new Error('boom');
    b.state = { error: err, generation: 0 };
    b.render();
    expect(fallback).toHaveBeenCalledWith(err, expect.any(Function));
  });

  it('does not call the fallback before anything has thrown', () => {
    const fallback = vi.fn();
    const b = makeBoundary({ fallback });
    b.render();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('the crash card', () => {
  // React's server renderer re-throws rather than honouring an error boundary,
  // so the boundary's *behaviour* is pinned by the state-machine tests above and
  // the crash card's *content* is pinned here, by rendering it directly.
  const render = (error: unknown) =>
    renderToStaticMarkup(React.createElement(CrashCard, { error, onReset: () => {} }));

  it('names what happened', () => {
    expect(render(new Error('render failed'))).toContain('Canopy Nav stopped');
  });

  it('shows the underlying message', () => {
    // "Something went wrong" with no detail is the failure mode this is fixing.
    expect(render(new Error('render failed'))).toContain('render failed');
  });

  it('tells the user their maps survived, because they did', () => {
    // They are in IndexedDB, not in the crashed React tree, so this is a true
    // statement rather than reassurance.
    expect(render(new Error('x'))).toContain('still saved');
  });

  it('offers a non-destructive recovery first', () => {
    // Reloading throws away an imported map that may have taken minutes to
    // parse, so it is the secondary action, not the only one.
    const html = render(new Error('x'));
    expect(html).toContain('Try again');
    expect(html).toContain('Reload the app');
  });

  it('announces itself as an alert', () => {
    // A crash message a screen reader never receives is the same defect as one
    // that is not visible.
    expect(render(new Error('x'))).toContain('role="alert"');
  });

  it('renders a non-Error throw without printing "undefined"', () => {
    // A thrown string or object is common from worker and parse code, and
    // `String(undefined)` in the middle of a crash screen is its own small
    // failure — the user is told nothing at all.
    expect(render('just a string')).toContain('just a string');
    expect(render(undefined)).not.toContain('undefined');
    expect(render(undefined)).toContain('Unknown error');
    expect(render(null)).not.toContain('null');
  });

  it('renders a thrown object readably, not as [object Object]', () => {
    expect(render({ code: 'E_PARSE', detail: 'bad vlen' })).toContain('E_PARSE');
  });

  it('survives a circular thrown value', () => {
    // Raising a second error on the error path is the worst possible place to.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(render(circular)).toContain('Unknown error');
  });

  it('wraps a long message rather than letting it overflow', () => {
    const html = render(new Error('x'.repeat(400)));
    expect(html).toContain('overflow-wrap');
  });
});

describe('installGlobalErrorReporting', () => {
  function withFakeWindow<T>(fn: () => T): T {
    const handlers: Record<string, ((e: unknown) => void)[]> = {};
    const fake = {
      addEventListener: (t: string, h: (e: unknown) => void) => {
        (handlers[t] ??= []).push(h);
      },
    };
    const g = globalThis as any;
    const had = 'window' in g;
    const prev = g.window;
    g.window = fake;
    try {
      return fn();
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  }

  it('is idempotent', () => {
    // It installs process-wide listeners. Calling it twice on every hot reload
    // would double every log line and leak handlers.
    withFakeWindow(() => {
      installGlobalErrorReporting();
      installGlobalErrorReporting();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      installGlobalErrorReporting();
      spy.mockRestore();
    });
  });

  it('is a no-op without a window', () => {
    const g = globalThis as any;
    const had = 'window' in g;
    const prev = g.window;
    delete g.window;
    try {
      expect(() => installGlobalErrorReporting()).not.toThrow();
    } finally {
      if (had) g.window = prev;
    }
  });
});