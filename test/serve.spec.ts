/**
 * Manual-test server tests.
 *
 * The server exists so the app can be exercised on a real phone (requirement
 * #20), which means it is the one piece of this project that is exposed to a
 * network. Path containment is therefore a security property, not a nicety, and
 * it is the kind of thing that regresses silently: stripping `../` before
 * `join` looks sufficient and is not, because `join` resolves whatever is left.
 *
 * Run with `npx vitest run test/serve.spec.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveRequestPath } from '../tools/serve.mjs';

const ROOT = '/srv/app/dist';

describe('resolveRequestPath — serving real files', () => {
  it('maps the root to index.html', () => {
    expect(resolveRequestPath(ROOT, '/')).toBe(`${ROOT}/index.html`);
  });

  it('resolves a nested asset', () => {
    expect(resolveRequestPath(ROOT, '/assets/index.js')).toBe(`${ROOT}/assets/index.js`);
  });

  it('ignores the query string', () => {
    expect(resolveRequestPath(ROOT, '/assets/index.js?v=2')).toBe(`${ROOT}/assets/index.js`);
  });

  it('decodes percent escapes', () => {
    expect(resolveRequestPath(ROOT, '/my%20file.osm')).toBe(`${ROOT}/my file.osm`);
  });
});

/**
 * The failure this section exists to prevent.
 *
 * `tools/serve.mjs` originally ran its start-up check on *import*: if `dist/`
 * was absent it called `process.exit(1)`. CI runs the unit tests before
 * `npm run build`, so importing this module from a spec killed the entire run —
 * 511 tests passed and then vitest died with "process.exit unexpectedly called
 * with 1". The fix is a `isMain` guard.
 *
 * The check reads `SERVE_ROOT` from the environment so the test can point it at a
 * directory that does not exist. Without that the check passes locally (because
 * `dist/` is built) and the regression is invisible until CI.
 */
describe('importing the module has no side effects', () => {
  it('does not exit the process when there is no build', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called on import');
    }) as never);
    const prev = process.env.SERVE_ROOT;
    // Point the start-up check at a path with no index.html, which is the CI
    // condition: the unit tests run before `npm run build`.
    process.env.SERVE_ROOT = '/definitely/not/a/real/path';
    try {
      // Cache-busting query forces a genuinely fresh evaluation, so the module
      // top level runs again rather than returning the cached instance.
      await import('../tools/serve.mjs?fresh-import-check');
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.SERVE_ROOT;
      else process.env.SERVE_ROOT = prev;
      exit.mockRestore();
    }
  });

  it('exposes a request handler without binding a port', async () => {
    const mod = await import('../tools/serve.mjs?handler-check');
    expect(typeof mod.createRequestHandler).toBe('function');
    expect(typeof mod.resolveRequestPath).toBe('function');
    // Building a handler must not listen, which is what would hang the suite.
    expect(() => mod.createRequestHandler('/nonexistent-root')).not.toThrow();
  });
});

describe('resolveRequestPath — containment', () => {
  /**
   * The property that matters is not "returns 403" but "never leaves ROOT".
   *
   * This implementation clamps rather than refuses: the traversal segments are
   * stripped and the remainder is joined onto ROOT, so `/../../../etc/passwd`
   * resolves to `<ROOT>/etc/passwd`, which does not exist and therefore falls
   * through to the SPA shell. Clamping is the better behaviour here — a 403 for
   * a malformed URL on a LAN test server is noise, and the security outcome is
   * identical.
   */
  const ATTACKS = [
    '/../../../etc/passwd',
    '/assets/../../../../etc/passwd',
    '/..%2f..%2fetc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/....//....//etc/passwd',
    '/%2fetc%2fpasswd',
    '/./../../etc/passwd',
  ];

  for (const attack of ATTACKS) {
    it(`never escapes ROOT for ${attack}`, () => {
      const r = resolveRequestPath(ROOT, attack);
      if (r !== null) {
        expect(r.startsWith(ROOT + '/')).toBe(true);
      }
    });
  }

  it('never returns a path outside ROOT for any input', () => {
    for (const attack of [...ATTACKS, '/', '/index.html', '/assets/a.js']) {
      const r = resolveRequestPath(ROOT, attack);
      expect(r === null || r.startsWith(ROOT + '/')).toBe(true);
    }
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // `/srv/app/dist-secret` starts with the root string but is a different
    // directory, so a prefix check without the separator would let it through.
    expect(resolveRequestPath(ROOT, '/../dist-secret/keys')).not.toBe(
      '/srv/app/dist-secret/keys',
    );
  });

  it('keeps a legitimate relative path working', () => {
    expect(resolveRequestPath(ROOT, '/assets/../index.html')).toBe(`${ROOT}/index.html`);
  });
});