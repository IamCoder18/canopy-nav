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
  // Public servers must use TLS. HTTP is useful only for local development.
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Public pack servers require HTTPS (Caddy can terminate TLS over IPv6)');
  url.pathname = url.pathname.replace(/\/$/, ''); return url;
}
function address(base: URL, path: string): string { return `${base.href.replace(/\/$/,'')}${path}`; }
export class PackService {
  private base: URL;
  constructor(private settings: PackServiceSettings, private fetcher: typeof fetch = fetch) { this.base = serviceAddress(settings); }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(address(this.base,path), { ...init, headers: { ...init.headers, 'X-API-Key': this.settings.apiKey.trim() }, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const e = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      // Never interpolate request headers or credentials into errors/logs.
      throw new Error(e?.error?.message ?? `Pack service returned HTTP ${response.status}`);
    } return response;
  }
  async submit(files: File[], region?: string, signal?: AbortSignal): Promise<{ id: string }> {
    if (!files.length || files.some((f) => !f.name.endsWith('.osm.pbf'))) throw new Error('Choose one or more .osm.pbf files');
    const body = new FormData(); for (const file of files) body.append('file',file); if (region) body.append('region',region);
    return (await this.request('/v1/builds',{ method: 'POST',body,signal })).json();
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
