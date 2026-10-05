/**
 * Settings persistence and endpoint validation.
 *
 * Two defects motivated this file.
 *
 * **Nothing persisted.** Engine choice, fallback policy, units, API key and
 * custom endpoint were all `useState` with no storage, so 0 of 5 survived a
 * reload. A driver who chose imperial units, or pointed the app at their own
 * Valhalla, silently got different routing than they had configured.
 *
 * **A present-but-broken endpoint read "Ready".** `not a url`, `htp:/broken` and
 * whitespace-only all passed, because readiness asked whether a string existed
 * rather than whether it could be fetched.
 *
 * Run with `npx vitest run test/settings.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  SETTINGS_KEYS, DEFAULT_SELECTION, DEFAULT_UNITS,
  readSelection, writeSelection, readUnits, writeUnits,
  readApiKey, writeApiKey, readEndpoint, writeEndpoint,
  validateEndpoint, isEndpointUsable,
  type Store,
} from '../src/settings';
import { engineStatuses } from '../src/nav/engines';

/** In-memory `Storage`, with an optional quota to exercise the failure path. */
function memStore(opts: { quota?: number } = {}): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      let bytes = 0;
      for (const [key, val] of data) bytes += key.length + val.length;
      if (opts.quota !== undefined && bytes + k.length + v.length > opts.quota) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      data.set(k, v);
    },
    removeItem: (k) => { data.delete(k); },
  };
}

const IDS = ['local', 'valhalla', 'valhalla-simplerouting', 'valhalla-custom', 'any-online'];

describe('round-tripping', () => {
  it('keeps the engine choice', () => {
    const s = memStore();
    writeSelection({ engine: 'valhalla-custom', fallback: 'fallback' }, s);
    expect(readSelection(IDS, s)).toEqual({ engine: 'valhalla-custom', fallback: 'fallback' });
  });

  it('keeps strict mode distinct from fallback', () => {
    const s = memStore();
    writeSelection({ engine: 'local', fallback: 'strict' }, s);
    expect(readSelection(IDS, s).fallback).toBe('strict');
  });

  it('keeps the unit system', () => {
    const s = memStore();
    writeUnits('imperial', s);
    expect(readUnits(s)).toBe('imperial');
  });

  it('keeps the API key, trimmed', () => {
    const s = memStore();
    writeApiKey('  sk-abc123\n', s);
    // A pasted key usually carries a newline, and a trailing \n in a header
    // value is a request that fails for no visible reason.
    expect(readApiKey(s)).toBe('sk-abc123');
  });

  it('keeps the custom endpoint', () => {
    const s = memStore();
    writeEndpoint(' http://192.168.1.10:8002 ', s);
    expect(readEndpoint(s)).toBe('http://192.168.1.10:8002');
  });

  it('round-trips every setting at once, which is what a reload does', () => {
    const s = memStore();
    writeSelection({ engine: 'valhalla', fallback: 'strict' }, s);
    writeUnits('imperial', s);
    writeApiKey('sk-xyz', s);
    writeEndpoint('https://valhalla.example.com', s);

    const restored = {
      selection: readSelection(IDS, s),
      units: readUnits(s),
      apiKey: readApiKey(s),
      endpoint: readEndpoint(s),
    };
    expect(restored).toEqual({
      selection: { engine: 'valhalla', fallback: 'strict' },
      units: 'imperial',
      apiKey: 'sk-xyz',
      endpoint: 'https://valhalla.example.com',
    });
  });
});

describe('defaults and hostile input', () => {
  it('falls back to the default when nothing is stored', () => {
    const s = memStore();
    expect(readSelection(IDS, s)).toEqual(DEFAULT_SELECTION);
    expect(readUnits(s)).toBe(DEFAULT_UNITS);
    expect(readApiKey(s)).toBe('');
    expect(readEndpoint(s)).toBe('');
  });

  it('survives a corrupt entry rather than throwing', () => {
    const s = memStore();
    s.setItem(SETTINGS_KEYS.selection, '{not json');
    expect(readSelection(IDS, s)).toEqual(DEFAULT_SELECTION);
  });

  it('survives a JSON value of the wrong shape', () => {
    for (const junk of ['null', '42', '"a string"', '[]', '{}']) {
      const s = memStore();
      s.setItem(SETTINGS_KEYS.selection, junk);
      expect(readSelection(IDS, s)).toEqual(DEFAULT_SELECTION);
    }
  });

  it('discards an engine id that no longer exists', () => {
    // The engine list changed under a saved entry. Selecting an unknown id would
    // leave the settings screen pointing at no row at all.
    const s = memStore();
    writeSelection({ engine: 'retired-engine', fallback: 'fallback' }, s);
    expect(readSelection(IDS, s).engine).toBe(DEFAULT_SELECTION.engine);
  });

  it('validates the two halves independently', () => {
    // A valid engine with a corrupt policy still yields a usable selection.
    const s = memStore();
    s.setItem(SETTINGS_KEYS.selection, JSON.stringify({ engine: 'valhalla', fallback: 42 }));
    expect(readSelection(IDS, s)).toEqual({ engine: 'valhalla', fallback: DEFAULT_SELECTION.fallback });
  });

  it('does not treat a non-string unit as imperial', () => {
    const s = memStore();
    s.setItem(SETTINGS_KEYS.units, 'furlongs');
    expect(readUnits(s)).toBe('metric');
  });

  it('clears a key when the value is emptied, not writes an empty string', () => {
    const s = memStore();
    writeApiKey('sk-abc', s);
    writeApiKey('', s);
    expect(readApiKey(s)).toBe('');
    expect(s.data.has(SETTINGS_KEYS.apiKey)).toBe(false);
  });
});

describe('storage that refuses', () => {
  it('reports a quota failure instead of throwing', () => {
    // Losing a preference must never take an import or a route down with it.
    const s = memStore({ quota: 10 });
    const problem = writeApiKey('sk-a-fairly-long-key-value', s);
    expect(problem).toMatch(/storage|save/i);
  });

  it('reports a hostile store without throwing', () => {
    const hostile: Store = {
      getItem: () => null,
      setItem: () => { throw new Error('nope'); },
      removeItem: () => { throw new Error('nope'); },
    };
    expect(() => writeApiKey('sk-x', hostile)).not.toThrow();
    expect(writeApiKey('sk-x', hostile)).toBeTruthy();
    expect(() => writeSelection({ engine: 'local', fallback: 'fallback' }, hostile)).not.toThrow();
  });

  it('reads as defaults when there is no store at all', () => {
    expect(readUnits(null)).toBe('metric');
    expect(readSelection(IDS, null)).toEqual(DEFAULT_SELECTION);
  });
});

describe('validateEndpoint', () => {
  it('accepts http and https, including a LAN address', () => {
    // A self-hosted valhalla_service on a home LAN is the documented use case
    // and 192.168.x.x has no certificate.
    expect(validateEndpoint('http://192.168.1.10:8002')).toBeNull();
    expect(validateEndpoint('https://valhalla.example.com')).toBeNull();
  });

  it('treats empty as "not configured", not as invalid', () => {
    // Reported separately and more usefully by the readiness logic.
    expect(validateEndpoint('')).toBeNull();
    expect(validateEndpoint('   ')).toBeNull();
  });

  it.each([
    // "not a url" trips the space check before the URL parser, which is the
    // more useful message for what the user actually typed.
    ['not a url', /spaces/],
    ['htp:/broken', /not supported/],
    ['example.com', /not a valid URL/],
    ['ftp://example.com', /not supported/],
    ['file:///etc/passwd', /not supported/],
    ['http://exa mple.com', /spaces/],
  ])('rejects %s', (value, pattern) => {
    const problem = validateEndpoint(value);
    expect(problem, `"${value}" was accepted`).toBeTruthy();
    expect(problem).toMatch(pattern);
  });

  it('distinguishes configured-and-valid from configured-and-broken', () => {
    expect(isEndpointUsable('http://192.168.1.10:8002')).toBe(true);
    expect(isEndpointUsable('not a url')).toBe(false);
    expect(isEndpointUsable('')).toBe(false);
  });
});

describe('readiness agrees with validation', () => {
  /** The custom engine's row. */
  const customRow = (endpoint: string) =>
    engineStatuses({ endpoint }, false).find((s) => s.id === 'valhalla-custom')!;

  it('reports a malformed endpoint as not ready', () => {
    // This is the defect: these used to report "Ready".
    for (const bad of ['not a url', 'htp:/broken', '   ', 'example.com']) {
      expect(customRow(bad).ready, `"${bad}" reported ready`).toBe(false);
    }
  });

  it('gives a reason that points at the address', () => {
    expect(customRow('not a url').reason).toMatch(/endpoint|address/i);
  });

  it('still reports an empty endpoint as "not configured"', () => {
    // Distinct message, because "you have not set one" and "the one you set is
    // broken" need different fixes.
    expect(customRow('').reason).toMatch(/no endpoint configured/i);
  });

  it('reports a well-formed endpoint as ready', () => {
    expect(customRow('http://192.168.1.10:8002').ready).toBe(true);
  });
});