/**
 * Region downloads — fetch a catalogue entry's `.osm.pbf` and hand back a
 * `File` that the existing import path (`store.ts` -> `OsmEngine.build`) can
 * parse directly.
 *
 * ## Why this module exists
 *
 * `RegionsScreen` only had a file picker: tapping "Alberta" opened a dialog and
 * nothing ever fetched bytes. This module is the missing half — a real
 * streaming downloader for `CATALOG` entries, so the user can download Alberta,
 * British Columbia, etc. and route between them.
 *
 * ## Streaming, not buffering
 *
 * A province extract is 100-900 MB. `response.arrayBuffer()` on that is how you
 * OOM a phone (and it makes a second full-size copy, because the ArrayBuffer
 * then has to be handed to the parser). So this reads
 * `response.body.getReader()` and keeps only the chunks as they arrive,
 * reporting progress from the byte count. The single unavoidable copy is the
 * `File`/`Blob` the parser wants, described below.
 *
 * ## What comes back
 *
 * `DownloadedRegion.file` is a real `File`, because `ImportRequest.file` in
 * `store.ts` is typed `File`. Handing back a duck-typed `OsmFile` instead would
 * mean widening that type and every caller of `importRegionFile`. `File` is a
 * `Blob`, so this costs exactly one copy of the payload (the Blob backing
 * store), which `new File(chunks, name)` at the end of `fetchOnce` performs
 * anyway. It also means the same object works with the picker path, with
 * `localRegionId()`/`localRegionName()` in `store.ts`, and with anything else
 * that treats it as a file.
 *
 * ## Content type: bytes, not headers
 *
 * Geofabrik serves `.osm.pbf`, and a mislabelled response is common: captive
 * portals, hotel wifi, corporate proxies and Geofabrik's own 404 page all
 * answer a request for a 400 MB file with **HTML and a 200 status**. Feeding
 * that to the PBF decoder produces a baffling "blob header length" error deep
 * in the parser. So the leading bytes are sniffed (`sniffFormat`), the same
 * trick `OsmEngine.build` uses, and anything that is not OSM PBF or OSM XML is
 * rejected up front with a message that says so. The filename is then derived
 * from the sniffed format, so the extension always matches the bytes.
 *
 * ## Abort, retry, resume
 *
 * `signal` aborts the read (the reader is cancelled and the loop raises a
 * clear "cancelled" error). A retryable failure (network drop, truncated body,
 * 5xx/429) is retried in place up to `retries` times, resuming with a
 * `Range`/`If-Range` request when the server honours it. On a device,
 * `@capacitor/filesystem` (already a dependency) keeps the partial bytes in the
 * app's data directory so an interrupted 900 MB download survives a restart;
 * everywhere else retry is in-memory only, within a single call.
 *
 * ## Disk space
 *
 * `navigator.storage.estimate()` is the only free-space API available here
 * (Capacitor's Filesystem plugin has none), so it is used when present and
 * skipped when it is not. Refusing before the first byte beats discovering at
 * 80% that the phone is full.
 *
 * Note the cost model honestly: the *download* streams, but the parser still
 * needs the whole file in memory, so this is not a streaming parser.
 *
 * ## Public API
 *
 *  - `downloadRegion(entry, opts)` — the download. Everything else supports it.
 *  - `checkRegionAvailable(entry)` — a `HEAD` probe for the catalogue UI. Never
 *    throws; an unreachable URL comes back as `{ ok: false, error }`.
 *  - `cachedRegion(entry)` / `clearCachedRegion(entry)` — the device copy.
 *  - `sniffFormat`, `formatBytes`, `estimateFreeBytes`, `hasDeviceStorage`,
 *    `DownloadError`.
 */

import type { CatalogEntry } from '../osm/regions';

/* ------------------------------- constants ------------------------------ */

const MB = 1024 * 1024;

/** Bytes of the head kept for format sniffing. */
const SNIFF_BYTES = 512;
/** Never sniff (and therefore never reject) before this many bytes arrived. */
const SNIFF_MIN = 16;
/** How often partial bytes are pushed to the device filesystem while downloading. */
const PART_FLUSH_BYTES = 4 * MB;
/** Extra attempts after a retryable failure. */
const DEFAULT_RETRIES = 2;
/** Refuse when the file needs more than this share of the free space. */
const DISK_HEADROOM = 0.9;
/** Subdirectory of the app data dir holding downloaded extracts. */
const REGION_DIR = 'canopy-regions';

/* --------------------------------- types -------------------------------- */

/** Format of the bytes actually downloaded, sniffed from the head. */
export type RegionFormat = 'pbf' | 'xml';

/** Result of inspecting the first bytes of a response. */
export type SniffResult = RegionFormat | 'html' | 'unknown';

export interface DownloadProgress {
  /** Bytes received so far. */
  received: number;
  /** Total bytes, or `null` when the server did not say (never 0, never NaN). */
  total: number | null;
  /** `received / total`, or `null` when `total` is unknown or zero. */
  fraction: number | null;
}

export interface DownloadedRegion {
  entry: CatalogEntry;
  /** File name handed to the parser; the extension matches `format`. */
  name: string;
  /** Bytes downloaded. */
  size: number;
  /** What the leading bytes actually were. */
  format: RegionFormat;
  /** Drop straight into `importRegionFile({ file })`. */
  file: File;
  /** Where the bytes came from: the network, or a previous download on disk. */
  source: 'network' | 'disk-cache';
  /** `Content-Length` / `Content-Range` total, or `null` if the server didn't say. */
  totalBytes: number | null;
  /** Where the copy was kept on the device, when one was. */
  path?: string;
  /**
   * Non-fatal problems worth showing, e.g. "the offline copy could not be
   * written". The download itself succeeded, so this is not an error.
   */
  warnings: string[];
}

export type DownloadErrorCode =
  | 'aborted'      // the caller aborted, or the user cancelled
  | 'network'      // no route to the host / connection died
  | 'http'         // the server answered, with a status that is not 2xx
  | 'not-osm'      // an HTML error page or some other non-OSM payload
  | 'empty'        // the response had no body
  | 'truncated'    // the stream ended early
  | 'disk-full';   // not enough room on the device
// Note: a failure to write the offline copy is *not* an error code. The bytes
// downloaded fine, so it comes back in `DownloadedRegion.warnings` instead.

/** Every failure path produces one of these with a message fit for a screen. */
export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    /** HTTP status, for `code === 'http'`. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  onProgress?: (p: DownloadProgress) => void;
  /** Abort the download. Produces a `DownloadError` with code `aborted`. */
  signal?: AbortSignal;
  /** Extra attempts after a retryable failure. Default 2, i.e. 3 tries. */
  retries?: number;
  /**
   * Size the caller already learned from a `checkRegionAvailable` probe. Used
   * for the free-space pre-check in preference to the catalogue's `approxMb`.
   */
  expectedBytes?: number;
  /** Skip the free-space pre-check. */
  assumeSpace?: boolean;
  /** Keep the finished file in the app's data directory. Default true on device. */
  keepOnDisk?: boolean;
  /** Keep partial bytes on disk so an interrupted download can resume. Default true on device. */
  resume?: boolean;
  /** Reuse a previously downloaded copy instead of fetching it again. Default true on device. */
  useCache?: boolean;
}

/* -------------------------------- helpers ------------------------------- */

/** `380 MB` / `1.4 GB`, for messages the user reads. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown size';
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(1)} GB`;
  if (n >= MB) return `${n >= 100 * MB ? Math.round(n / MB) : (n / MB).toFixed(1)} MB`;
  if (n === 0) return '0 B';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Short human label: `"Alberta" (ca-ab)`. */
function label(entry: CatalogEntry): string {
  return `"${entry.name}" (${entry.id})`;
}

/** Where the bytes are coming from, trimmed for a message. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') {
    const err = e as { name?: string; message?: string };
    if (err.message) return `${err.name ? `${err.name}: ` : ''}${err.message}`;
    if (err.name) return err.name;
  }
  return 'unknown error';
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** A short, quoted, printable look at the first bytes, for error messages. */
function preview(head: Uint8Array): string {
  let s = '';
  for (let i = 0; i < Math.min(head.length, 16); i++) {
    const b = head[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0x0a ? '\\n' : `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return JSON.stringify(s);
}

/** One downloaded chunk, typed so `File`/`Blob` constructors accept it. */
type Chunk = Uint8Array<ArrayBuffer>;

/**
 * Normalise a reader's chunk into something `Blob` can take.
 *
 * A stream reader may hand back a view onto a larger buffer (and lib.dom types
 * it over `ArrayBufferLike`), so the bytes are copied only when the view is not
 * the whole buffer. Copying unconditionally would double peak memory for a
 * 900 MB download, which is exactly what this module exists to avoid.
 */
function toChunk(chunk: Uint8Array): Chunk {
  if (chunk.buffer instanceof ArrayBuffer &&
      chunk.byteOffset === 0 &&
      chunk.byteLength === chunk.buffer.byteLength) {
    return chunk as Chunk;
  }
  return chunk.slice();
}

/** Join chunks into one buffer. Only for small batches, never a whole extract. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Latin-1-ish lowercase of the head, for case-insensitive marker matching. */
function lowerAscii(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    s += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : String.fromCharCode(c);
  }
  return s;
}

/* ------------------------------ format sniff ---------------------------- */

const XML_MARKERS = ['<osm', '<?xml'];
const HTML_MARKERS = [
  '<!doctype', '<html', '<head', '<body', '<title', '<script', '<meta',
  '<h1', '<div', '<span', '<a href', '<!--', '<?php',
];

/**
 * Decide what a payload is from its leading bytes.
 *
 * Deliberately the same rule as `OsmEngine.build`: OSM XML begins with `<`
 * (after an optional BOM and whitespace) and PBF never does. The extra work here
 * is separating OSM XML from the HTML that error pages are made of — an
 * unrecognised `<` is reported as `unknown` rather than `xml`, because a
 * province download that is really a captive-portal page must never reach the
 * parser as if it were data.
 */
export function sniffFormat(head: Uint8Array): SniffResult {
  const n = Math.min(head.length, SNIFF_BYTES);
  let i = 0;
  if (n >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < n && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  if (i >= n) return 'unknown';             // nothing but whitespace so far
  if (head[i] !== 0x3c) return 'pbf';       // protobuf never starts with '<'
  const text = lowerAscii(head.subarray(i, i + Math.min(n - i, 256)));
  if (XML_MARKERS.some((m) => text.includes(m))) return 'xml';
  if (HTML_MARKERS.some((m) => text.includes(m))) return 'html';
  // A '<' we do not recognise is far more likely to be a web page than an
  // extract: real OSM XML says `<osm` or `<?xml` within the first few hundred
  // bytes.
  return 'unknown';
}

/**
 * File name for the payload: the catalogue URL's own basename when it has a
 * sensible one, with the extension corrected to match the sniffed format.
 */
function fileNameFor(entry: CatalogEntry, format: RegionFormat): string {
  let base = '';
  try {
    const seg = new URL(entry.pbfUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    base = decodeURIComponent(seg);
  } catch {
    base = '';
  }
  if (!base || /[<>:"/\\|?*]/.test(base)) base = entry.id;
  base = base.replace(/\.(osm\.pbf|osm|pbf|xml|html?|txt)$/i, '');
  if (!base) base = entry.id;
  return `${base}${format === 'xml' ? '.osm' : '.osm.pbf'}`;
}

/* ------------------------------- progress ------------------------------- */

/**
 * Emits `{ received, total, fraction }` and guarantees the value never goes
 * backwards. Progress that jumps back to 0% mid-download reads as a bug to the
 * user, which matters when the only thing on screen is a bar.
 *
 * The cost of that guarantee: if a server ignores a `Range` request, the retry
 * really does start again at 0% and the bar sits still until it catches up. A
 * stalled bar is a smaller lie than a bar that lies about going backwards.
 */
class ProgressReporter {
  private highWater = 0;
  private total: number | null = null;

  constructor(private emit: ((p: DownloadProgress) => void) | undefined) {}

  setTotal(total: number | null) {
    if (total !== null && Number.isFinite(total) && total > 0) this.total = total;
  }

  report(received: number) {
    this.highWater = Math.max(this.highWater, received);
    // A decoded body can be longer than a gzipped Content-Length; trust what we
    // actually received so the bar and the fraction stay truthful.
    if (this.total !== null && this.highWater > this.total) this.total = this.highWater;
    const t = this.total;
    this.emit?.({
      received: this.highWater,
      total: t,
      fraction: t !== null && t > 0 ? clamp01(this.highWater / t) : null,
    });
  }
}

/* ------------------------------ free space ------------------------------ */

export interface FreeSpace {
  /** Bytes free, or `null` when the platform will not say. */
  freeBytes: number | null;
  quotaBytes: number | null;
  usedBytes: number | null;
}

/**
 * Ask the platform how much room is left.
 *
 * `navigator.storage.estimate()` is the only free-space signal available in a
 * Capacitor WebView; Capacitor's Filesystem plugin has no equivalent. Resolves
 * with `freeBytes: null` rather than rejecting — not being able to check is not
 * a reason to refuse to download.
 */
export async function estimateFreeBytes(): Promise<FreeSpace> {
  try {
    const storage = (globalThis.navigator as { storage?: { estimate?: () => Promise<StorageEstimate> } } | undefined)
      ?.storage;
    if (typeof storage?.estimate !== 'function') {
      return { freeBytes: null, quotaBytes: null, usedBytes: null };
    }
    const est = await storage.estimate();
    const quota = typeof est.quota === 'number' && Number.isFinite(est.quota) ? est.quota : null;
    const used = typeof est.usage === 'number' && Number.isFinite(est.usage) ? est.usage : null;
    const free = quota !== null ? Math.max(0, quota - (used ?? 0)) : null;
    return { freeBytes: free, quotaBytes: quota, usedBytes: used };
  } catch {
    return { freeBytes: null, quotaBytes: null, usedBytes: null };
  }
}

/** Bytes the catalogue says this entry needs, as a last-resort estimate. */
function approxBytes(entry: CatalogEntry): number {
  return entry.approxMb > 0 ? Math.round(entry.approxMb * MB) : 0;
}

/**
 * Refuse early when the file clearly will not fit.
 *
 * `required` is the real `Content-Length` when the caller has it, otherwise the
 * catalogue's `approxMb`. A little headroom is demanded because the parsed
 * dataset, the IndexedDB copy and the partial file all land on the same device
 * afterwards.
 */
async function checkSpace(
  entry: CatalogEntry,
  required: number | null,
): Promise<void> {
  if (!required || required <= 0) return;
  const { freeBytes } = await estimateFreeBytes();
  if (freeBytes === null) return;   // cannot tell; do not block the download
  const need = Math.ceil(required / DISK_HEADROOM);
  if (need <= freeBytes) return;
  throw new DownloadError(
    'disk-full',
    `There is not enough room for ${label(entry)}: the download needs about ` +
    `${formatBytes(required)} and this device has ${formatBytes(freeBytes)} free. ` +
    'Remove a downloaded region or free up space, then try again.',
  );
}

/* ---------------------------- availability probe ------------------------ */

export interface Availability {
  ok: boolean;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** `Content-Length`, when the server sent one. */
  bytes: number | null;
  /** Whether the server advertises byte ranges, i.e. a retry can resume. */
  resumable: boolean;
  /** `ETag` if present — the validator an `If-Range` resume must use. */
  etag: string | null;
  /** When the file was last changed, if the server said. */
  modified: string | null;
  /** Populated instead of throwing, so a screen can show it inline. */
  error: string | null;
}

/**
 * Check a catalogue URL before offering the download button.
 *
 * `HEAD` first because it costs nothing, with a one-byte ranged `GET` as the
 * fallback for servers (and proxies) that reject `HEAD`. Never throws: an
 * unreachable URL is a result, not an exception, because this is a UI affordance.
 */
export async function checkRegionAvailable(
  entry: CatalogEntry,
  opts: { signal?: AbortSignal } = {},
): Promise<Availability> {
  const base: Availability = {
    ok: false, status: 0, bytes: null, resumable: false, etag: null, modified: null, error: null,
  };
  try {
    let res: Response | null = null;
    try {
      res = await fetch(entry.pbfUrl, { method: 'HEAD', signal: opts.signal });
    } catch (headErr) {
      if (isAbort(opts.signal)) throw headErr;
      res = null;    // no HEAD to be had; ask for a byte instead
    }
    // 405/501 (and some proxies' 400) mean "I do not do HEAD", not "the file is
    // missing", so ask for the first byte instead.
    if (res === null || res.status === 405 || res.status === 501 || res.status === 400) {
      res = await fetch(entry.pbfUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: opts.signal,
      });
      if (!res.ok) {
        discardBody(res);
        return { ...base, status: res.status, error: httpMessage(entry, res) };
      }
      // A ranged GET gives the size in Content-Range, not Content-Length.
      const total = totalFromRange(res.headers.get('content-range'));
      discardBody(res);
      return {
        ok: true,
        status: res.status,
        bytes: total,
        resumable: true,
        etag: res.headers.get('etag'),
        modified: res.headers.get('last-modified'),
        error: null,
      };
    }

    const ok = res.ok;
    // HEAD has no body, but cancelling is free and keeps the invariant local:
    // every path out of this function releases the response.
    discardBody(res);
    return {
      ok,
      status: res.status,
      bytes: contentLength(res.headers.get('content-length'), 0),
      // Only a byte-range hit proves resumability; headers are advisory.
      resumable: /bytes/i.test(res.headers.get('accept-ranges') ?? ''),
      etag: res.headers.get('etag'),
      modified: res.headers.get('last-modified'),
      error: ok ? null : httpMessage(entry, res),
    };
  } catch (e) {
    if (isAbort(opts.signal)) throw aborted(entry, 0, null);
    return { ...base, error: networkMessage(entry, e) };
  }
}

/* --------------------------------- errors ------------------------------- */

/**
 * Release a response body we are not going to read.
 *
 * The one-byte ranged `GET` above resolves on *headers*, so its body is still
 * streaming when the function returns — and a browser will keep pulling the rest
 * of the file unless it is explicitly cancelled. Measured: opening the regions
 * screen transferred 9,961,472 bytes for a 619,019-byte file, a 16x over-fetch,
 * and against the real catalogue (province extracts are 100-900 MB) it would
 * have pulled gigabytes the user never asked for.
 *
 * `cancel()` rather than draining the stream, which would defeat the point.
 */
function discardBody(res: Response): void {
  try {
    void res.body?.cancel();
  } catch {
    // Already closed or locked. Nothing to release.
  }
}

function contentLength(raw: string | null, offset: number): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // A 206 reports the length of the *remainder*, so the whole file is bigger.
  return offset > 0 ? offset + n : n;
}

function totalFromRange(raw: string | null): number | null {
  if (!raw) return null;
  const m = /\/(\d+)\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function httpMessage(entry: CatalogEntry, res: Response): string {
  const status = res.status;
  const what = `the server answered ${status}${res.statusText ? ` ${res.statusText}` : ''}`;
  let hint: string;
  if (status === 404 || status === 410) {
    hint = ' The catalogue URL is wrong or the extract has been renamed — ' +
      'check the URL, or import an extract file manually.';
  } else if (status === 401 || status === 403) {
    hint = ' The server refused the request; the extract may sit behind a licence ' +
      'acceptance or a mirror that needs a login.';
  } else if (status === 429) {
    hint = ' Too many requests — wait a minute and try again.';
  } else {
    hint = ' Try again, or download the extract with a browser and import the file.';
  }
  return `${label(entry)} could not be downloaded: ${what} for ${entry.pbfUrl}.${hint}`;
}

function httpError(entry: CatalogEntry, res: Response): DownloadError {
  return new DownloadError('http', httpMessage(entry, res), res.status);
}

/**
 * What to say when a catalogue request never produced a response.
 *
 * A browser `fetch` that rejects with a `TypeError` did not get an HTTP status at
 * all — the request was blocked before a response was formed. In a WebView the
 * overwhelmingly common cause is cross-origin policy: Geofabrik sends no
 * `Access-Control-Allow-Origin`, so every catalogue URL is unreadable from the
 * browser build, and the old wording told the user to "check the device's
 * network" when their network was fine.
 *
 * `fetch` deliberately does not let script tell a CORS block from a dead host,
 * so this says what is actually knowable: the request never got a response, and
 * the most likely reason is that the browser blocked it. It offers the route
 * that works regardless — download the file yourself and import it.
 */
function networkMessage(entry: CatalogEntry, e: unknown): string {
  const why = describe(e);
  if (/failed to fetch|networkerror|load failed/i.test(why)) {
    return `${label(entry)} could not be fetched from ${host(entry.pbfUrl)} — the browser blocked ` +
      'the request before any response came back. Extract hosts do not allow cross-origin reads, ' +
      'so this normally means one-tap download is unavailable here. Download the .osm.pbf from a ' +
      'browser and use Import instead; nothing about your connection is wrong.';
  }
  return `${label(entry)} could not be downloaded: no connection to ${host(entry.pbfUrl)} ` +
    `(${why}). Check the device's network and try again.`;
}

function networkError(entry: CatalogEntry, e: unknown): DownloadError {
  return new DownloadError('network', networkMessage(entry, e));
}

function notOsmError(entry: CatalogEntry, head: Uint8Array, what: SniffResult): DownloadError {
  const reason = what === 'html'
    ? `it looks like an HTML web page (a 404 page, a sign-in wall, or a captive portal), starting with ${preview(head)}`
    : `it starts with ${preview(head)}, which is neither OSM PBF nor OSM XML`;
  return new DownloadError(
    'not-osm',
    `The download of ${label(entry)} failed: the response from ${entry.pbfUrl} was not OSM data — ` +
    `${reason}. This usually means a proxy, portal or error page answered instead of the extract. ` +
    'Try a different network, or download the file with a browser and import it here.',
  );
}

function emptyError(entry: CatalogEntry): DownloadError {
  return new DownloadError(
    'empty',
    `The download of ${label(entry)} produced no data. The server accepted the request but ` +
    `returned an empty body for ${entry.pbfUrl}. Try again later.`,
  );
}

function truncatedError(entry: CatalogEntry, received: number, total: number): DownloadError {
  return new DownloadError(
    'truncated',
    `The download of ${label(entry)} stopped early: ${formatBytes(received)} of ` +
    `${formatBytes(total)} arrived and the connection ended. Nothing was saved. ` +
    'Try again — the download resumes where it stopped.',
  );
}

function aborted(entry: CatalogEntry, received: number, total: number | null): DownloadError {
  const where = total ? ` at ${Math.round((received / total) * 100)}%` : '';
  return new DownloadError(
    'aborted',
    `The download of ${label(entry)} was cancelled${where}. Nothing was saved; ` +
    'you can download it again at any time.',
  );
}

function isAbort(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

/** Which failures are worth another go. A wrong URL or a bad payload is not. */
function retryable(err: DownloadError): boolean {
  switch (err.code) {
    case 'network':
    case 'truncated':
      return true;
    case 'http': {
      const status = err.status ?? 0;
      // 408 (request timeout), 429 (rate limited) and anything 5xx are the
      // server-side blips worth retrying; 404 is not going to change.
      return status === 408 || status === 429 || status >= 500;
    }
    default:
      return false;
  }
}

/** Anything thrown from below becomes a `DownloadError` with a real message. */
function toDownloadError(e: unknown, entry: CatalogEntry): DownloadError {
  if (e instanceof DownloadError) return e;
  if (e instanceof Error && e.name === 'AbortError') {
    return aborted(entry, 0, null);
  }
  return networkError(entry, e);
}

/* --------------------------- Capacitor filesystem ------------------------ */

/**
 * `@capacitor/filesystem` bindings, loaded on demand.
 *
 * The plugin is a real dependency, but it is only useful on a device, so the
 * import is dynamic and gated on `Capacitor.isNativePlatform()`: in a browser
 * (and in the test runner) this resolves to `null` and every caller falls back
 * to in-memory behaviour. The web implementation stores blobs in IndexedDB,
 * which `regions/persist.ts` already does for the *parsed* dataset, so adding a
 * second copy of the raw extract there would be pure waste.
 */
/** The plugin, typed only: it is imported dynamically so nothing is bundled. */
type FsModule = typeof import('@capacitor/filesystem');
/** The `Encoding` enum's *value* type, e.g. `Encoding.UTF8`. */
type FsEncodingValue = import('@capacitor/filesystem').Encoding;

interface FsBinding {
  fs: FsModule['Filesystem'];
  dir: FsModule['Directory']['Data'];
}

let binding: Promise<FsBinding | null> | null = null;

function filesystem(): Promise<FsBinding | null> {
  if (!binding) {
    binding = (async (): Promise<FsBinding | null> => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return null;
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        return { fs: Filesystem, dir: Directory.Data };
      } catch {
        // Missing plugin, or a WebView that refuses the import. Downloads still
        // work; they just cannot be resumed from disk.
        return null;
      }
    })();
  }
  return binding;
}

/** True when extracts can be kept on the device filesystem. Never throws. */
export async function hasDeviceStorage(): Promise<boolean> {
  return (await filesystem()) !== null;
}

function finalPath(entry: CatalogEntry): string {
  return `${REGION_DIR}/${entry.id}`;
}

function partPath(entry: CatalogEntry): string {
  return `${REGION_DIR}/${entry.id}.part`;
}

function metaPath(entry: CatalogEntry): string {
  return `${REGION_DIR}/${entry.id}.part.json`;
}

interface PartMeta {
  url: string;
  etag: string | null;
  modified: string | null;
  total: number | null;
}

/** Best-effort: a missing directory is created, a failure is not fatal. */
async function ensureDir(b: FsBinding): Promise<void> {
  try {
    await b.fs.mkdir({ path: REGION_DIR, directory: b.dir, recursive: true });
  } catch {
    // Already there, or the platform creates parents itself.
  }
}

/**
 * Read a binary file. Native returns base64 (Blob is web-only), so this decodes
 * it in slices — a province-sized `atob` is not something to hand to a phone.
 *
 * The decoded length has to account for `=` padding, or the buffer comes back
 * with phantom trailing zero bytes and the "file" silently gains garbage at the
 * end. The slice size is a multiple of 4 so every slice but the last is a whole
 * number of base64 quanta.
 */
async function readBinary(b: FsBinding, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const res = await b.fs.readFile({ path, directory: b.dir });
    const data = res.data as string | Blob;
    if (typeof data !== 'string') {
      return new Uint8Array(await (data as Blob).arrayBuffer());
    }
    const clean = data.replace(/[^A-Za-z0-9+/=]/g, '');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const size = Math.floor((clean.length * 3) / 4) - pad;
    if (size <= 0) return new Uint8Array(0);
    const out = new Uint8Array(size);
    // 1 MB of base64 is 786 432 bytes: a whole number of quanta, so slicing here
    // cannot split one.
    const CH = 786_432;
    for (let i = 0; i < clean.length; i += CH) {
      const bin = atob(clean.slice(i, i + CH));
      const start = (i * 3) / 4;
      for (let j = 0; j < bin.length; j++) out[start + j] = bin.charCodeAt(j);
    }
    return out.subarray(0, size);
  } catch {
    return null;
  }
}

/**
 * Base64 for `appendFile`, which only accepts a string.
 *
 * Sliced, because `btoa` on a province-sized binary string would be a second
 * province-sized allocation. The slice size is a multiple of 3 so no slice ever
 * ends mid-quantum: a `=` pad inside the string makes every decoder stop there,
 * which silently truncates the file.
 */
function toBase64(bytes: Uint8Array): string {
  const CH = 24576;                       // 3 x 8192
  const codes: number[] = new Array(CH);
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += CH) {
    const n = Math.min(bytes.byteLength - i, CH);
    for (let j = 0; j < n; j++) codes[j] = bytes[i + j];
    out += btoa(String.fromCharCode.apply(null, codes.slice(0, n)));
  }
  return out;
}

async function fileSize(b: FsBinding, path: string): Promise<number | null> {
  try {
    const st = await b.fs.stat({ path, directory: b.dir });
    return typeof st.size === 'number' && st.size > 0 ? st.size : null;
  } catch {
    return null;
  }
}

async function removeQuietly(b: FsBinding, path: string): Promise<void> {
  try {
    await b.fs.deleteFile({ path, directory: b.dir });
  } catch {
    // Nothing to delete, or the platform will not let us; not worth reporting.
  }
}

async function readMeta(b: FsBinding, entry: CatalogEntry): Promise<PartMeta | null> {
  try {
    const res = await b.fs.readFile({
      path: metaPath(entry), directory: b.dir, encoding: 'utf8' as FsEncodingValue,
    });
    const parsed = JSON.parse(String(res.data)) as PartMeta;
    return parsed && parsed.url === entry.pbfUrl ? parsed : null;
  } catch {
    return null;
  }
}

async function writeMeta(b: FsBinding, entry: CatalogEntry, meta: PartMeta): Promise<void> {
  try {
    await b.fs.writeFile({
      path: metaPath(entry),
      directory: b.dir,
      data: JSON.stringify(meta),
      encoding: 'utf8' as FsEncodingValue,
    });
  } catch {
    // Without the validator a resume restarts from zero — still correct.
  }
}

/**
 * Sinks streamed chunks into the app's data directory so an interrupted
 * download can be continued after a restart. Flushing every few MB rather than
 * every chunk keeps the bridge traffic sane; anything still buffered is lost if
 * the app dies, and the next attempt starts from the last flush.
 */
class PartSink {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private failed = false;
  /** Bytes actually on disk. The part file is always exactly this prefix. */
  private persisted = 0;

  private constructor(
    private b: FsBinding,
    private entry: CatalogEntry,
    private readonly path: string,
  ) {}

  static async open(entry: CatalogEntry, resume: boolean): Promise<PartSink | null> {
    const b = await filesystem();
    if (!b || !resume) return null;
    await ensureDir(b);
    return new PartSink(b, entry, partPath(entry));
  }

  /** How many bytes are safely on disk — the prefix a resume may trust. */
  get persistedBytes(): number { return this.persisted; }

  async push(chunk: Uint8Array): Promise<void> {
    if (this.failed) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes < PART_FLUSH_BYTES) return;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.failed || !this.pendingBytes) return;
    const data = this.pending;
    const bytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      // `appendFile` takes a base64 string, so this is the one place a chunk
      // costs 4/3 its size in extra memory. Hence the 4 MB flush threshold.
      await this.b.fs.appendFile({ path: this.path, directory: this.b.dir, data: toBase64(concat(data)) });
      this.persisted += bytes;
    } catch {
      // Out of room or no permission. The download is still valid in memory;
      // it just cannot be resumed later, so stop trying on every chunk.
      this.failed = true;
    }
  }

  /** The partial file is now the finished file; clear it. */
  async complete(): Promise<void> {
    await this.flush();
    await removeQuietly(this.b, this.path);
    await removeQuietly(this.b, metaPath(this.entry));
    this.persisted = 0;
  }
}

/* --------------------------- reading a cached copy ---------------------- */

/**
 * A previously downloaded extract, if one is still on the device.
 *
 * The native plugin returns binary reads as base64, so this decodes a
 * province-sized string — the same order of memory as parsing it. That is the
 * price of resuming across restarts on a device, and it is still cheaper than
 * downloading 900 MB again.
 */
export async function cachedRegion(entry: CatalogEntry): Promise<DownloadedRegion | null> {
  const b = await filesystem();
  if (!b) return null;
  await ensureDir(b);
  const bytes = await readBinary(b, finalPath(entry));
  if (!bytes || bytes.byteLength === 0) return null;
  const verdict = sniffFormat(bytes.subarray(0, SNIFF_BYTES));
  if (verdict !== 'pbf' && verdict !== 'xml') return null;
  const name = fileNameFor(entry, verdict);
  return {
    entry,
    name,
    size: bytes.byteLength,
    format: verdict,
    file: new File([bytes], name),
    source: 'disk-cache',
    totalBytes: bytes.byteLength,
    path: finalPath(entry),
    warnings: [],
  };
}

/** Delete the offline copy (and any partial file) for a catalogue entry. */
/**
 * Drop the device copy for a region.
 *
 * Takes an id as well as a catalogue entry so the manage screen can clear the
 * cached extract when a region is removed, using the id it already has.
 */
export async function clearCachedRegion(entry: CatalogEntry | string): Promise<void> {
  const b = await filesystem();
  if (!b) return;
  const id = typeof entry === 'string' ? entry : entry.id;
  await removeQuietly(b, `${REGION_DIR}/${id}`);
  await removeQuietly(b, `${REGION_DIR}/${id}.part`);
  await removeQuietly(b, `${REGION_DIR}/${id}.part.json`);
}

/* ------------------------------ the download ---------------------------- */

/** State carried from a failed attempt to the next one. */
interface Resume {
  /** Bytes already held in memory. */
  chunks: Chunk[];
  /** Length of those bytes. */
  received: number;
  /** `ETag`/`Last-Modified` of the entity, for `If-Range`. */
  validator: string | null;
  /**
   * What the head of the *whole file* was, decided on the first attempt.
   *
   * A resumed attempt starts mid-file, and the middle of an `.osm` document is
   * full of `<` characters that mean nothing on their own, so re-sniffing there
   * would reject a perfectly good XML extract. The verdict carries over instead.
   */
  format: RegionFormat | null;
  /**
   * Bytes the device filesystem has actually written.
   *
   * Tracked separately because flushing is batched: memory can run ahead of
   * disk, and a resume that requested bytes from `received` while the part file
   * only held `persisted` would splice the file at the wrong offset and produce
   * a corrupt extract.
   */
  persisted: number;
  /**
   * Whether a device part file is being written.
   *
   * Only then does `persisted` constrain a retry: with no filesystem the whole
   * in-memory buffer is intact, and trimming it to a disk offset that does not
   * exist would throw away good bytes and restart from zero every time.
   */
  sinkActive: boolean;
}

/** Drop everything past `to` bytes, so memory and disk agree again. */
function truncateTo(chunks: readonly Chunk[], to: number): Chunk[] {
  if (to <= 0) return [];
  const out: Chunk[] = [];
  let at = 0;
  for (const c of chunks) {
    if (at >= to) break;
    if (at + c.byteLength > to) {
      out.push(c.subarray(0, to - at));
      break;
    }
    out.push(c);
    at += c.byteLength;
  }
  return out;
}

/**
 * Download a catalogue entry and return it as a `File` ready for the import
 * path.
 *
 * Rejects with a `DownloadError` carrying a `code` and a message meant for a
 * person; it never resolves with a partial or a non-OSM payload. Retries
 * `retries` extra times on a retryable failure, resuming with a `Range` request
 * when it can.
 *
 * Everything optional is a no-op on a platform without Capacitor's Filesystem:
 * the download still works, it just cannot be resumed after a restart.
 */
export async function downloadRegion(
  entry: CatalogEntry,
  opts: DownloadOptions = {},
): Promise<DownloadedRegion> {
  if (isAbort(opts.signal)) throw aborted(entry, 0, null);

  const reporter = new ProgressReporter(opts.onProgress);
  const b = await filesystem();
  const useCache = opts.useCache ?? b !== null;
  const resume = opts.resume ?? b !== null;
  const keepOnDisk = opts.keepOnDisk ?? b !== null;

  if (useCache && b) {
    const cached = await cachedRegion(entry);
    if (cached) {
      // A cached copy has no meaningful total beyond its own length.
      reporter.setTotal(cached.size);
      reporter.report(cached.size);
      return cached;
    }
  }

  // Refuse before the first byte when the file clearly will not fit.
  if (!opts.assumeSpace) {
    await checkSpace(entry, opts.expectedBytes && opts.expectedBytes > 0 ? opts.expectedBytes : approxBytes(entry));
  }

  const resumeState = await resumeFrom(entry, b, resume);
  const attempts = Math.max(1, (opts.retries ?? DEFAULT_RETRIES) + 1);
  let last: DownloadError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchOnce(entry, opts, reporter, resumeState, b, resume, keepOnDisk);
    } catch (e) {
      const err = toDownloadError(e, entry);
      last = err;
      if (err.code === 'aborted' || attempt === attempts || !retryable(err)) break;
      // Try again from what is provably intact. With a device filesystem that
      // is the flushed prefix, so a failure at 80% does not restart at 0%; with
      // no filesystem the whole in-memory buffer is intact and is reused as-is.
      if (resumeState.sinkActive && resumeState.persisted < resumeState.received) {
        resumeState.chunks = truncateTo(resumeState.chunks, resumeState.persisted);
        resumeState.received = resumeState.persisted;
      }
    }
  }

  throw last ?? networkError(entry, new Error('download failed'));
}

/**
 * Load whatever survived a previous attempt, if it is safe to continue it.
 *
 * Three ways this can refuse, and they are deliberately not the same:
 *
 *  - **No validator.** `If-Range` is what stops the server splicing a prefix from
 *    a different version of the file onto these bytes, so without one the file
 *    cannot be resumed *safely* and is deleted.
 *  - **The prefix is not OSM data.** Sniffed rather than trusted, which closes a
 *    loop that used to be permanent — see the note below.
 *  - **The prefix could not be read.** The file exists (its size was just taken)
 *    but `readBinary` failed, which on a device means the base64 decode ran out
 *    of memory on a 620 MB province. That is a transient condition of *this
 *    attempt*, and it is not evidence about the bytes on disk, so **nothing is
 *    deleted**. Deleting here is what made an OOM silently throw away a transfer
 *    that had already transferred most of a province.
 */
async function resumeFrom(
  entry: CatalogEntry,
  b: FsBinding | null,
  resume: boolean,
): Promise<Resume> {
  const state: Resume = {
    chunks: [], received: 0, validator: null, format: null, persisted: 0, sinkActive: false,
  };
  if (!b || !resume) return state;
  const have = await fileSize(b, partPath(entry));
  if (!have) return state;
  const meta = await readMeta(b, entry);
  if (!meta) {
    // No validator, so the server cannot be told to refuse a stale prefix.
    await removeQuietly(b, partPath(entry));
    return state;
  }
  const prefix = await readBinary(b, partPath(entry));
  if (!prefix || prefix.byteLength !== have) {
    // Unreadable *now*. The next attempt starts from zero, and `fetchOnce` clears
    // the stale part before writing anything, so leaving the bytes here is safe
    // and deleting them is not.
    return state;
  }

  /**
   * Why the prefix is sniffed, which is the whole of the fix for a permanently
   * failed download.
   *
   * A `not-osm` rejection can land *after* bytes are already on disk: `absorb`
   * only decides once `SNIFF_MIN` bytes have arrived, so the first chunk of a
   * short response is written to the part file before the second one settles the
   * verdict. The download then fails — correctly — and leaves a poisoned part file
   * and a `.part.json` beside it.
   *
   * On the next attempt that prefix was trusted, `Range` was sent for the rest of
   * the payload, and the sniff ran again on the *tail*. So it failed the same way,
   * wrote a little more, and failed again: every retry resumed from bad bytes and
   * could not succeed. Not slow, not intermittent — permanently broken, with a
   * message about the format that named the wrong cause.
   *
   * The prefix is the head of the *whole* file by construction (`PartSink` only
   * ever appends to a path the previous attempt cleared, so the part file always
   * starts at byte 0), so sniffing it here is exactly the sniff that could not be
   * done at the time.
   */
  const verdict = sniffFormat(prefix.subarray(0, Math.min(SNIFF_BYTES, have)));
  if (verdict !== 'pbf' && verdict !== 'xml') {
    // Genuinely worthless bytes: they are what made every retry fail.
    await removeQuietly(b, partPath(entry));
    await removeQuietly(b, metaPath(entry));
    return state;
  }

  state.chunks = [prefix];
  state.received = have;
  // Everything read back is also on disk.
  state.persisted = have;
  state.validator = meta.etag ?? meta.modified;
  // The verdict carries into the request, so a mid-file attempt does not have to
  // re-sniff bytes it no longer has.
  state.format = verdict;
  return state;
}

/** One request, from wherever the last attempt got to. */
async function fetchOnce(
  entry: CatalogEntry,
  opts: DownloadOptions,
  reporter: ProgressReporter,
  resume: Resume,
  b: FsBinding | null,
  resumeOnDisk: boolean,
  keepOnDisk: boolean,
): Promise<DownloadedRegion> {
  const signal = opts.signal;
  if (isAbort(signal)) throw aborted(entry, resume.received, null);

  const headers: Record<string, string> = {};
  if (resume.received > 0) {
    headers.Range = `bytes=${resume.received}-`;
    if (resume.validator) headers['If-Range'] = resume.validator;
  }

  let res: Response;
  try {
    res = await fetch(entry.pbfUrl, { headers, signal });
  } catch (e) {
    if (isAbort(signal)) throw aborted(entry, resume.received, null);
    throw networkError(entry, e);
  }
  if (!res.ok) {
    // Release the body before reporting. `fetch` resolves on *headers*, so an error
    // page is still streaming — and `retryable()` treats 429, 500 and 503 as worth
    // another attempt, so this path runs up to `retries + 1` times with every previous
    // error body still being pulled in the background.
    //
    // The `try`/`finally` that owns the reader is not entered on this path, so
    // nothing else releases it. `checkRegionAvailable` discards on all four of its
    // exits for exactly this reason, justified there by a measurement: opening the
    // regions screen transferred 9,961,472 bytes for a 619,019-byte file.
    discardBody(res);
    throw httpError(entry, res);
  }

  // Track the validator of the entity now being read: `If-Range` on a later
  // attempt is what stops the server splicing a prefix from a different version
  // of the file onto these bytes.
  resume.validator = res.headers.get('etag') ?? res.headers.get('last-modified') ?? resume.validator;

  // A server that ignores Range answers 200 with the whole file; anything else
  // (206 with a different start, 416) means the prefix is not usable.
  let continuing = false;
  if (resume.received > 0) {
    continuing = res.status === 206;
    if (!continuing) {
      resume.chunks = [];
      resume.received = 0;
    }
  }

  const total =
    totalFromRange(res.headers.get('content-range')) ??
    contentLength(res.headers.get('content-length'), resume.received);
  reporter.setTotal(total);
  reporter.report(resume.received);

  // A mid-file attempt cannot sniff anything useful, so it inherits the verdict
  // from the attempt that read byte 0.
  const inherited = resume.format;
  let format: RegionFormat | null = inherited;
  let decided = inherited !== null;

  // A part file only exists while there is a sink to write it, and the sink only
  // exists when the device filesystem is in play. `persisted` starts at the
  // resumed prefix length, which is exactly what the previous sink left there.
  const sink = resumeOnDisk ? await PartSink.open(entry, true) : null;
  resume.sinkActive = sink !== null;
  resume.persisted = sink ? resume.received : 0;
  if (sink && b && !continuing) {
    // Starting over (fresh download, or the server ignored the range request):
    // the stale partial must not be appended to, and the validator for the next
    // resume has to be recorded now.
    await removeQuietly(b, partPath(entry));
    await writeMeta(b, entry, {
      url: entry.pbfUrl,
      etag: res.headers.get('etag'),
      modified: res.headers.get('last-modified'),
      total,
    });
  }

  const body = res.body;
  const warnings: string[] = [];

  let received = resume.received;
  const head = new Uint8Array(SNIFF_BYTES);
  let headLen = 0;
  /**
   * Get rid of bytes this attempt has already written, when the payload is not OSM.
   *
   * A `not-osm` rejection could previously land *after* the first chunk was
   * flushed to the part file — `absorb` only decides once `SNIFF_MIN` bytes have
   * arrived, and a chunk smaller than that is written on the way past. What was
   * left behind was a part file holding the head of somebody's HTML error page,
   * plus a `.part.json` that made it look resumable. Every later attempt resumed
   * from those bytes and failed the same way, so the download was permanently
   * broken while reporting a format problem each time.
   *
   * Only when the sink exists, and only the partial — the finished copy of a
   * *previous* good download is a different path and is not touched.
   */
  const discardPoisonedPrefix = async () => {
    if (!sink || !b) return;
    await removeQuietly(b, partPath(entry));
    await removeQuietly(b, metaPath(entry));
    resume.persisted = 0;
    resume.sinkActive = false;
  };

  const absorb = (chunk: Uint8Array) => {
    if (decided) return;
    head.set(chunk.subarray(0, Math.min(chunk.byteLength, SNIFF_BYTES - headLen)), headLen);
    headLen += Math.min(chunk.byteLength, SNIFF_BYTES - headLen);
    if (headLen < SNIFF_MIN) return;
    decided = true;
    const verdict = sniffFormat(head.subarray(0, headLen));
    if (verdict !== 'pbf' && verdict !== 'xml') rejectNotOsm(head.subarray(0, headLen), verdict);
    format = verdict;
    resume.format = verdict;
  };

  /** Set when a payload is rejected as non-OSM, so the prefix can be cleaned up. */
  let poisoned = false;

  /**
   * The single place a payload is rejected, so no call site can forget to flag it.
   *
   * Typed as a `const` with an explicit signature rather than inferred, because
   * TypeScript only treats a call as never-returning for control-flow purposes
   * when the callee's type is written down — which is what keeps
   * `verdict !== 'pbf' && verdict !== 'xml'` narrowing `verdict` to a
   * `RegionFormat` on the line after.
   */
  const rejectNotOsm: (bytes: Uint8Array, verdict: SniffResult) => never = (bytes, verdict) => {
    poisoned = true;
    throw notOsmError(entry, bytes, verdict);
  };

  /**
   * The read, with the poisoned-prefix cleanup on the way out.
   *
   * Wrapping the whole read rather than adding a call at each of the four
   * rejection sites: the cleanup is a property of *any* `not-osm` failure, and a
   * fifth site added later would otherwise be the one that forgets. It has to be
   * here rather than at the end of the function because an `absorb` rejection
   * happens mid-stream, with a sink open and bytes already flushed to disk.
   */
  try {
  if (!body) {
    // No streaming body support (older WebViews, some proxies). This is the one
    // path that materialises the response at once; say so rather than pretend.
    warnings.push('This browser could not stream the download, so the whole file was buffered in memory.');
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (e) {
      if (isAbort(signal)) throw aborted(entry, received, total);
      throw networkError(entry, e);
    }
    const bytes = toChunk(new Uint8Array(buf));
    absorb(bytes);
    decided = true;
    if (!format) {
      const verdict = sniffFormat(bytes.subarray(0, SNIFF_BYTES));
      if (verdict !== 'pbf' && verdict !== 'xml') rejectNotOsm(bytes.subarray(0, 16), verdict);
      format = verdict;
      resume.format = verdict;
    }
    resume.chunks = [bytes];
    resume.received = bytes.byteLength;
    received = bytes.byteLength;
    reporter.report(received);
  } else {
    const reader = body.getReader();
    const onAbort = () => { void reader.cancel('cancelled by user').catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let drained = false;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (e) {
          // Flush before unwinding: what reached the disk is the only prefix a
          // retry is allowed to trust.
          if (sink) await sink.flush();
          resume.persisted = sink ? sink.persistedBytes : 0;
          if (isAbort(signal)) throw aborted(entry, received, total);
          // A cancelled reader surfaces as an error on some platforms.
          throw networkError(entry, e);
        }
        if (isAbort(signal)) throw aborted(entry, received, total);
        if (step.done) { drained = true; break; }
        const chunk = step.value;
        // Keep only the bytes that were actually received.
        const bytes = toChunk(chunk);
        absorb(bytes);
        received += bytes.byteLength;
        resume.received = received;
        resume.chunks.push(bytes);
        reporter.report(received);
        if (sink) await sink.push(bytes);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // A rejected payload or a dropped connection leaves the body half-read;
      // cancel it so the socket is not held open for a 400 MB error page.
      if (!drained) void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* already released by cancel() */ }
    }
    if (isAbort(signal)) throw aborted(entry, received, total);
  }

  // Settle the persisted prefix before any of the checks below can throw, so a
  // retryable failure (a short read, a dropped connection) still leaves a part
  // file whose length matches what memory holds.
  if (sink) await sink.flush();
  resume.persisted = sink ? sink.persistedBytes : 0;

  // Checked before the format: an empty body has nothing to sniff, and "the
  // server sent no data" is a far more useful message than "that is not OSM".
  if (received === 0) throw emptyError(entry);

  // Only now is the format certain (a short response only settles at the end).
  if (!format) {
    const verdict = sniffFormat(head.subarray(0, headLen));
    if (verdict !== 'pbf' && verdict !== 'xml') rejectNotOsm(head.subarray(0, headLen), verdict);
    format = verdict;
  }
  resume.format = format;
  } catch (e) {
    // The bytes of a rejected payload are worse than no bytes: the next attempt
    // resumes from them and fails the same way, forever.
    if (poisoned) await discardPoisonedPrefix();
    throw e;
  }

  if (total !== null && received < total) throw truncatedError(entry, received, total);

  const name = fileNameFor(entry, format);
  const file = new File(resume.chunks, name, {
    type: format === 'xml' ? 'application/xml' : 'application/octet-stream',
  });

  reporter.report(received);

  let path: string | undefined;
  if (keepOnDisk && b) {
    const dest = `${REGION_DIR}/${entry.id}`;
    try {
      await ensureDir(b);
      await b.fs.writeFile({ path: dest, directory: b.dir, data: file });
      path = dest;
    } catch (e) {
      // The download is good even if the offline copy is not, so this is a warning and
      // not a failure. What is lost, precisely: the *resume* copy.
      //
      // The old wording said "It will only be available until the app is closed", and
      // that is both false and the most alarming sentence in the file. The finished
      // file is imported and persisted separately, by `saveRegion` in `store.ts`, so
      // the **map** survives a restart and a reboot — that is the whole point of
      // downloading it. What this cache is for is `cachedRegion`, which lets an
      // *interrupted* download continue from where it stopped instead of re-fetching
      // 380 MB to 1.4 GB from byte zero.
      //
      // Telling a driver their province will vanish when they close the app, when it
      // will not, is worse than saying nothing: it is the kind of warning that makes
      // people avoid the feature that works.
      warnings.push(
        `${label(entry)} downloaded, and the map is saved — but this copy could not be ` +
        `kept on the device (${describe(e)}), so if the download is interrupted you will ` +
        'have to start it again rather than resume it.',
      );
    }
  }

  // The finished file replaces the part file either way, so the partial must go
  // whether the copy was kept or not.
  if (sink) {
    await sink.complete();
    resume.persisted = 0;
  }
  return {
    entry,
    name,
    size: file.size,
    format,
    file,
    source: 'network',
    totalBytes: total,
    ...(path ? { path } : {}),
    warnings,
  };
}