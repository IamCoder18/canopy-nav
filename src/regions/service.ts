import { validateManifest, diskGate, type BundleManifest } from './bundle';
import type { PackServiceSettings } from '../settings';
export interface BuildStatus {
  id: string; state: 'queued' | 'running' | 'done' | 'failed';
  stages: { name: string; state: string; ms: number }[];
  progress: Record<string, number>;
  error?: { code: string; message: string; detail: string };
}
export function serviceAddress(settings: PackServiceSettings): URL {
  let url: URL;
  try { url = new URL(settings.url.trim()); } catch { throw new Error('Provide a pack server address, for example https://packs.example.org'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Pack server address must be an HTTP(S) URL without credentials, query or fragment');
  if (!settings.apiKey.trim()) throw new Error('Provide the pack server API key');
  // Self-hosted pack servers may sit on plain HTTP (a LAN box, or a host whose
  // TLS is terminated elsewhere), and this app accepts that by explicit choice.
  // `isInsecureTransport` lets the UI say so out loud rather than pretending a
  // clear-text link is private.
  url.pathname = url.pathname.replace(/\/$/, ''); return url;
}

/**
 * Whether this address sends the API key over clear text.
 *
 * Loopback is exempt: it never leaves the device. Everything else on `http:`
 * crosses the network unencrypted, so the settings screen warns about it.
 */
export function isInsecureTransport(url: URL): boolean {
  return url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname);
}
function address(base: URL, path: string): string { return `${base.href.replace(/\/$/,'')}${path}`; }

/** Bytes the *default* server configuration accepts (`PACKSERVER_MAX_UPLOAD_MB`). */
const DEFAULT_UPLOAD_CAP = 2048 * 1024 * 1024;

export interface UploadProgress {
  /** Bytes handed to the network so far. */
  sent: number;
  /** Total bytes, or `null` when the platform does not report one. */
  total: number | null;
  /** `sent / total`, or `null` when the total is unknown or zero. */
  fraction: number | null;
}
export interface SubmitOptions { region?: string; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void; }

/**
 * The filename rules `server/src/api.rs` enforces *after* the bytes have arrived,
 * checked here first so a phone does not push a gigabyte at a server that will
 * refuse its name. Kept literal rather than regex-collapsed so each rule can be
 * matched to its counterpart in the Rust handler.
 */
export function validateUploads(files: File[]): File[] {
  if (!files.length) throw new Error('Choose one or more .osm.pbf files');
  if (files.length > 128) throw new Error('The pack server takes at most 128 extracts per build. Split these across several builds.');
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.name.endsWith('.osm.pbf')) throw new Error(`“${f.name}” is not a .osm.pbf extract. Convert it first — osmium cat region.osm -o region.osm.pbf — and choose the converted file.`);
    // Mirrors the Rust handler's `filename.contains(['/', '\\', '\0', '\n', '\r', '\''])`
    // plus its length and leading-dot rules, character by character.
    const unsafe = f.name.startsWith('.') || f.name.length > 180 || ['/', '\\', '\0', '\n', '\r', "'"].some((c) => f.name.includes(c));
    if (unsafe) throw new Error(`“${f.name}” is not a filename the pack server accepts. Rename it to a plain name ending in .osm.pbf.`);
    if (seen.has(f.name)) throw new Error(`Two of the chosen files are both called “${f.name}”. Each input needs its own name.`);
    seen.add(f.name);
  }
  return files;
}

/**
 * An advisory, not a refusal: the cap is the *server's* configuration and only
 * the server knows it. Oversize bodies are refused from the Content-Length
 * before a byte is accepted, so the worst case is a fast failure — but the user
 * should hear about the limit before leaving on a multi-gigabyte send.
 */
export function uploadSizeNote(files: File[]): string | null {
  const total = files.reduce((n, f) => n + (Number.isFinite(f.size) ? f.size : 0), 0);
  if (total <= DEFAULT_UPLOAD_CAP) return null;
  return `These files total ${Math.round(total / 1048576)} MB. The pack server's default upload limit is 2 GB (PACKSERVER_MAX_UPLOAD_MB) — crop large extracts with osmium extract, or the upload will be refused.`;
}

/**
 * The service's `{error:{code,message,detail}}` contract as something a driver
 * can act on, with the server's own words kept alongside rather than replaced
 * (the same policy as the routing engine's error translation). Never includes
 * request headers or credentials.
 */
export function explainFailure(status: number, body: unknown, retryAfter?: string | null): string {
  const e = (body as { error?: { code?: string; message?: string; detail?: string } } | null | undefined)?.error;
  const code = typeof e?.code === 'string' ? e.code : '';
  const raw = [typeof e?.message === 'string' ? e.message : '', typeof e?.detail === 'string' ? e.detail : ''].filter(Boolean).join(' — ');
  const minutes = Number(retryAfter) / 60;
  const retry = Number.isFinite(minutes) && minutes >= 1 ? ` Try again in about ${Math.round(minutes)} minutes.` : ' Try again later.';
  let action = '';
  if (status === 401 || code === 'unauthorized') action = 'The pack server rejected the API key. Check it in Settings → Pack service.';
  else if (status === 413 || code === 'too_large') action = 'The upload is larger than the pack server accepts. Crop the extract — osmium extract -b <west,south,east,north> in.osm.pbf -o area.osm.pbf — or raise PACKSERVER_MAX_UPLOAD_MB on the server.';
  else if (code === 'input_not_pbf') action = 'The pack server refused the input: every file must be a real .osm.pbf extract.';
  else if (code === 'input_unsorted') action = 'The pack server could not sort this extract. Sort it first — osmium sort in.osm.pbf -o sorted.osm.pbf — and upload again.';
  else if (status === 429 || code === 'rate_limited') action = `The pack server is limiting uploads for this key (2 at a time, 10 per hour by default).${retry}`;
  else if (code === 'not_ready') action = 'That build is not finished yet.';
  return action ? (raw ? `${action} The server said: ${raw}` : action) : (raw || `Pack service returned HTTP ${status}`);
}

export class PackService {
  private base: URL;
  // The XHR factory is injectable because `upload()` is XHR-only (see below) and
  // a unit test must be able to drive it without a network.
  constructor(private settings: PackServiceSettings, private fetcher: typeof fetch = fetch, private xhr: () => XMLHttpRequest = () => new XMLHttpRequest()) { this.base = serviceAddress(settings); }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(address(this.base,path), { ...init, headers: { ...init.headers, 'X-API-Key': this.settings.apiKey.trim() }, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const e = await response.json().catch(() => null);
      // Never interpolate request headers or credentials into errors/logs.
      throw new Error(explainFailure(response.status, e, response.headers.get('Retry-After')));
    } return response;
  }
  async submit(files: File[], options: SubmitOptions = {}): Promise<{ id: string }> {
    const body = new FormData();
    for (const file of validateUploads(files)) body.append('file', file, file.name);
    const region = options.region?.trim();
    if (region) body.append('region', region);
    return this.upload(body, options);
  }
  /**
   * POST the multipart build request.
   *
   * This is `XMLHttpRequest`, not `fetch`, for one reason: it is the only way a
   * WebView reports *upload* progress, and a province extract is a multi-minute,
   * multi-hundred-megabyte send from a phone. What `fetch` was buying here —
   * `redirect: 'error'`, the no-credentials/no-referrer policy — is
   * re-established explicitly below.
   */
  private upload(body: FormData, options: SubmitOptions): Promise<{ id: string }> {
    return new Promise((resolve, reject) => {
      const xhr = this.xhr();
      const onAbort = () => xhr.abort();
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        finish();
      };
      if (options.signal?.aborted) { settle(() => reject(options.signal?.reason ?? new DOMException('The upload was cancelled.', 'AbortError'))); return; }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      xhr.open('POST', address(this.base, '/v1/builds'));
      // Key only to the configured origin, exactly as `request()` sends it.
      xhr.setRequestHeader('X-API-Key', this.settings.apiKey.trim());
      xhr.upload.onprogress = (e) => options.onProgress?.({ sent: e.loaded, total: e.lengthComputable ? e.total : null, fraction: e.lengthComputable && e.total > 0 ? e.loaded / e.total : null });
      xhr.onload = () => settle(() => {
        // XHR follows redirects silently, so `redirect: 'error'` is enforced by
        // hand: a response that did not come from the configured origin is
        // refused before its body is trusted.
        if (xhr.responseURL && new URL(xhr.responseURL).origin !== this.base.origin) { reject(new Error('The pack server redirected the upload; the response is refused.')); return; }
        let payload: unknown = null;
        try { payload = JSON.parse(xhr.responseText); } catch { /* the status check says it plainly */ }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(explainFailure(xhr.status, payload, xhr.getResponseHeader('Retry-After')))); return; }
        const raw = (payload as { id?: unknown } | null)?.id;
        if (typeof raw !== 'string') { reject(new Error('The pack server did not return a build id')); return; }
        try { resolve({ id: this.id(raw) }); } catch (e) { reject(e); }
      });
      xhr.onerror = () => settle(() => reject(new Error(`Could not reach the pack server at ${this.base.host}. Check the address and this device's connection.`)));
      xhr.onabort = () => settle(() => reject(options.signal?.reason ?? new DOMException('The upload was cancelled.', 'AbortError')));
      xhr.send(body);
    });
  }
  private id(id: string): string { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid build id'); return id; }
  async status(id: string, signal?: AbortSignal): Promise<BuildStatus> { return (await this.request(`/v1/builds/${this.id(id)}`,{signal})).json(); }
  async poll(id: string, options: { signal?: AbortSignal; onProgress?: (s: BuildStatus) => void; timeoutMs?: number } = {}): Promise<BuildStatus> {
    let delay = 500; const deadline = Date.now() + (options.timeoutMs ?? 3 * 3600_000);
    for (;;) {
      options.signal?.throwIfAborted();
      const status = await this.status(id,options.signal); options.onProgress?.(status);
      if (status.state === 'done') return status;
      if (status.state === 'failed') throw new Error([status.error?.message ?? 'Pack build failed', status.error?.detail].filter(Boolean).join('\n'));
      if (!['queued','running'].includes(status.state)) throw new Error('Invalid build state');
      if (Date.now() >= deadline) throw new Error('Pack build timed out; you can retrieve it later using its build id');
      await new Promise<void>((resolve,reject) => {
        const abort = () => { clearTimeout(timer); reject(options.signal?.reason); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort',abort); resolve(); },delay);
        options.signal?.addEventListener('abort',abort,{once:true});
      }); delay = Math.min(10000,delay * 1.5);
    }
  }
  async manifest(id: string, signal?: AbortSignal): Promise<BundleManifest> { return validateManifest(await (await this.request(`/v1/builds/${this.id(id)}/artifacts`,{signal})).json()); }
  async download(id: string, signal?: AbortSignal): Promise<Blob> {
    const manifest = await this.manifest(id,signal); await diskGate(manifest);
    const response = await this.request(`/v1/builds/${this.id(id)}/bundle`,{signal});
    if (!response.body) throw new Error('Empty bundle response');
    const reader = response.body.getReader(); const parts: ArrayBuffer[] = []; let size = 0;
    const cap = manifest.artifacts.reduce((n,a) => n+a.bytes,0) * 1.02 + 2 * 1024 * 1024;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > cap) throw new Error('Bundle exceeds manifest size'); parts.push(r.value.slice().buffer); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return new Blob(parts,{ type: 'application/gzip' });
  }
}
