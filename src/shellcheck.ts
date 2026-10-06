/**
 * Is a document this app, or something wearing its URL?
 *
 * Split out of `sw.ts` for the same reason `nav/engines.ts` is separate from
 * `nav/providers.ts`: the decision is worth testing, and the only place it is used
 * is a service worker, which no unit suite renders. A predicate that can only be
 * exercised by booting a browser and unplugging the network is a predicate nobody
 * will run.
 *
 * The rule is deliberately two conditions rather than one, because each alone is
 * weak:
 *
 *  - `<div id="root">` is the mount point Vite emits. It is also a common enough
 *    element name that a login page could carry it.
 *  - `<script type="module">` is what any modern page has.
 *
 * Together they are a shape only this build produces. Neither is sufficient; a
 * carrier "session expired" interstitial is HTML with a module script, and a
 * developer-tools overlay is HTML with a `#root`.
 */

/** What the predicate needs from the platform, so it can be tested without one. */
export interface ShellProbe {
  /** Where the worker itself is served from. */
  origin: string;
  /** Final URL, after any redirects. */
  url: string;
  status: number;
  redirected: boolean;
  contentType: string | null;
  /** The body. Callers pass `res.clone().text()` so nothing is consumed twice. */
  body: string;
}

/**
 * True only for a document this app could boot from.
 *
 * Fails closed: anything unrecognised is not the app. The cost of a false
 * positive is permanent — the cached shell becomes a login page and the app can
 * never open offline again — and the cost of a false negative is one online load
 * that is not precached.
 */
export function looksLikeAppShell(probe: ShellProbe): boolean {
  // A redirect off our own origin means the bytes came from somewhere else, which
  // a content-type check alone would not catch: a captive portal serves HTML.
  if (probe.redirected) {
    try {
      if (new URL(probe.url).origin !== probe.origin) return false;
    } catch {
      // An unparseable URL is not evidence of the app.
      return false;
    }
  }
  // Only a successful response can be the shell. `opaque` responses report status
  // 0 and would otherwise pass a `content-type` check on a redirect chain.
  if (probe.status < 200 || probe.status > 299) return false;
  if (!/text\/html/i.test(probe.contentType ?? '')) return false;
  // Both are attribute-order independent, because a check that only recognises one
  // spelling would silently stop precaching on a toolchain bump — and the failure
  // would not appear until someone opened the app with no network.
  return hasRootMount(probe.body) && hasModuleScript(probe.body);
}

/** Does this document carry the mount point Vite renders into? */
function hasRootMount(html: string): boolean {
  for (const tag of html.match(/<div\b[^>]*>/gi) ?? []) {
    if (/\bid\s*=\s*["']root["']/i.test(tag)) return true;
  }
  return false;
}

/** Does this document load the bundle as a module? */
function hasModuleScript(html: string): boolean {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (/\btype\s*=\s*["']module["']/i.test(tag)) return true;
  }
  return false;
}