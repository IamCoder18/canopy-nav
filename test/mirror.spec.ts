/**
 * Tests for the Geofabrik mirror's allowlist.
 *
 * `resolveMirrorUrl` turns a caller-supplied request path into an absolute URL
 * that `tools/serve.mjs` will then fetch. If it can be made to return anything
 * other than a `https://download.geofabrik.de/...` URL, the endpoint is an open
 * proxy: it can be pointed at loopback, at link-local metadata services, or at
 * anything else the server can reach, and it does so on behalf of whoever can
 * load the page.
 *
 * So the shape of the accepted input is the security boundary, and it is pinned
 * here rather than left to inspection. Run with
 * `npx vitest run test/mirror.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { resolveMirrorUrl } from '../tools/serve.mjs';

const PREFIX = '/mirror/geofabrik/';

describe('resolveMirrorUrl — accepts real catalogue paths', () => {
  const href = (p: string) => resolveMirrorUrl(p)?.href ?? null;

  it('resolves a Geofabrik extract to its upstream URL', () => {
    expect(href(`${PREFIX}north-america/canada/ontario-latest.osm.pbf`))
      .toBe('https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf');
  });

  it('accepts a top-level extract', () => {
    expect(href(`${PREFIX}europe/germany-latest.osm.pbf`))
      .toBe('https://download.geofabrik.de/europe/germany-latest.osm.pbf');
  });

  it('drops a query string rather than letting it through', () => {
    expect(href(`${PREFIX}europe/germany-latest.osm.pbf?x=1`))
      .toBe('https://download.geofabrik.de/europe/germany-latest.osm.pbf');
  });

  it('accepts the .gz variant', () => {
    // This one was genuinely broken and the test caught it: the shape check
    // demanded the path end in `.osm.pbf`, so a `.osm.pbf.gz` catalogue entry
    // could never be mirrored at all.
    expect(href(`${PREFIX}europe/germany-latest.osm.pbf.gz`))
      .toBe('https://download.geofabrik.de/europe/germany-latest.osm.pbf.gz');
  });
});

describe('resolveMirrorUrl — refuses everything else', () => {
  // Each of these is a way of asking the server to fetch something that is not a
  // public OpenStreetMap extract. The expected answer is always null.
  const attacks: [string, string][] = [
    ['a non-extractable file', `${PREFIX}../../../../etc/passwd`],
    ['a traversal in the middle', `${PREFIX}north-america/../../../etc/passwd`],
    ['an encoded traversal', `${PREFIX}north-america/%2e%2e/%2e%2e/etc/passwd`],
    ['a backslash separator', `${PREFIX}north-america\\..\\..\\etc\\passwd`],
    ['an absolute URL as the path', `${PREFIX}https://evil.example.com/x.osm.pbf`],
    ['a protocol-relative URL', `${PREFIX}//evil.example.com/x-latest.osm.pbf`],
    ['an arbitrary scheme', `${PREFIX}file:///etc/passwd`],
    ['a javascript: URL', `${PREFIX}javascript:alert(1)`],
    ['a host with a port', `${PREFIX}evil.example.com:8080/x-latest.osm.pbf`],
    ['a userinfo trick', `${PREFIX}download.geofabrik.de@evil.example.com/x.osm.pbf`],
    ['a loopback host as a directory', `${PREFIX}127.0.0.1/x-latest.osm.pbf`],
    ['a domain as a directory', `${PREFIX}evil.example.com/x-latest.osm.pbf`],
    ['an empty remainder', PREFIX],
    ['a bare dot', `${PREFIX}.`],
    ['a shell-ish query', `${PREFIX}?url=http://evil.example.com`],
    ['a non-pbf extension', `${PREFIX}north-america/canada/ontario-latest.json`],
    ['a fragment', `${PREFIX}europe/germany-latest.osm.pbf#x`],
    ['a directory with no file', `${PREFIX}north-america/canada/`],
    ['a leading dash segment', `${PREFIX}-x-latest.osm.pbf`],
  ];

  for (const [name, input] of attacks) {
    it(`refuses ${name}`, () => {
      expect(resolveMirrorUrl(input), `accepted ${input}`).toBeNull();
    });
  }

  it('refuses a path outside the mirror prefix entirely', () => {
    // The handler checks the prefix before calling this, but the resolver must
    // not depend on that ordering for its own safety.
    expect(resolveMirrorUrl('/north-america/canada/ontario-latest.osm.pbf')).toBeNull();
  });

  it('never returns a URL on another origin, for any input at all', () => {
    // A property rather than a list: whatever the input, if this returns
    // anything, it is on the one host we agreed to talk to.
    const inputs = [
      ...attacks.map(([, i]) => i),
      `${PREFIX}north-america/canada/ontario-latest.osm.pbf`,
      `${PREFIX}europe/germany-latest.osm.pbf.gz`,
    ];
    for (const i of inputs) {
      const got = resolveMirrorUrl(i);
      if (got === null) continue;
      expect(got.origin, `origin escaped for ${i}`).toBe('https://download.geofabrik.de');
      expect(got.protocol).toBe('https:');
      expect(got.username).toBe('');
      expect(got.password).toBe('');
      expect(got.port).toBe('');
    }
  });
});