import type { OsmDataset } from '../osm/engine.worker';
import type { GazEntry } from '../search/gaz';
import type { Region, RegionMeta } from '../osm/regions';
import { parseTarIndex, getLocalValhalla } from '../nav/valhalla-local';
import { savePack, deletePack } from './packstore';
import { putArtifact, getArtifact, deleteArtifacts } from './artifactstore';
import { bundleRecords, writeBundleRecord } from './bundlestore';

export interface BundleArtifact {
  name: string; role: 'routing' | 'search' | 'basemap'; format: string; bytes: number; sha256: string;
  'content-type': string; tiles?: number; entries?: number; minzoom?: number; maxzoom?: number;
}
export interface BundleManifest {
  format: 'canopy-bundle/1';
  build: { id: string; created: string; packserver: string; valhalla: string };
  region: { name: string; bbox: [number, number, number, number]; counts: OsmDataset['counts'] };
  inputs: { filename: string; bytes: number; sha256: string; sorted: boolean; resorted: boolean }[];
  artifacts: BundleArtifact[];
}
const FORMATS = { 'routing.valhalla.tar': ['routing', 'valhalla-gph-tar/1'], 'search.gazetteer.jsonl.gz': ['search', 'canopy-gazetteer/1'], 'map.pmtiles': ['basemap', 'pmtiles/3'] } as const;
export function validateManifest(value: unknown): BundleManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid bundle manifest');
  const m = value as BundleManifest;
  if (m.format !== 'canopy-bundle/1' || !m.build || typeof m.build.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(m.build.id) || !m.region || typeof m.region.name !== 'string' || !Array.isArray(m.region.bbox) || m.region.bbox.length !== 4 || !m.region.bbox.every(Number.isFinite)) throw new Error('Unsupported or invalid bundle manifest');
  const [w,s,e,n] = m.region.bbox;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n || !m.region.counts || !['nodes','ways','routable'].every((k) => Number.isSafeInteger(m.region.counts[k as keyof OsmDataset['counts']]) && m.region.counts[k as keyof OsmDataset['counts']] >= 0)) throw new Error('Invalid bundle region');
  if (!Number.isFinite(Date.parse(m.build.created)) || typeof m.build.valhalla !== 'string' || typeof m.build.packserver !== 'string') throw new Error('Invalid bundle build provenance');
  if (!Array.isArray(m.inputs) || !m.inputs.length || m.inputs.some((i) => !i || !/^[a-f0-9]{64}$/.test(i.sha256) || typeof i.filename !== 'string' || !Number.isSafeInteger(i.bytes) || i.bytes < 0 || typeof i.sorted !== 'boolean' || typeof i.resorted !== 'boolean')) throw new Error('Invalid bundle input provenance');
  if (!Array.isArray(m.artifacts) || m.artifacts.length !== 3) throw new Error('Bundle must contain routing, search and map artifacts');
  const seen = new Set<string>();
  for (const a of m.artifacts) {
    if (!a || typeof a.name !== 'string' || !Object.prototype.hasOwnProperty.call(FORMATS,a.name)) throw new Error('Invalid bundle artifact');
    const f = FORMATS[a.name as keyof typeof FORMATS];
    if (!f || seen.has(a.name) || f[0] !== a.role || f[1] !== a.format || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('Invalid bundle artifact');
    seen.add(a.name);
  }
  if (!Number.isSafeInteger(m.artifacts.reduce((n,a) => n+a.bytes,0))) throw new Error('Invalid bundle size');
  return m;
}
export async function diskGate(manifest: BundleManifest): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  const { quota, usage } = await navigator.storage.estimate();
  const needed = manifest.artifacts.reduce((n,a) => n + a.bytes, 0);
  // Artifacts are unpacked once; no retained compressed transport archive.
  if (quota != null && quota - (usage ?? 0) < needed) throw new Error(`Not enough storage for this bundle (${Math.ceil(needed / 1048576)} MB needed). Remove a region first.`);
}
export async function loadGazetteer(blob: Blob): Promise<GazEntry[]> {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  const entries: GazEntry[] = []; let pending = ''; const ids = new Set<string>();
  const line = (s: string) => {
    if (!s.trim()) return;
    const e = JSON.parse(s) as GazEntry & { type: string; id: string };
    if (!e || ['city','state','country','street'].some((k) => e[k as keyof GazEntry] != null && typeof e[k as keyof GazEntry] !== 'string')) throw new Error('Invalid gazetteer context');
    if (!/^(node|way|relation)\/-?\d+$/.test(e.id) || typeof e.name !== 'string' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon) || Math.abs(e.lat) > 90 || Math.abs(e.lon) > 180 || typeof e.type !== 'string' || typeof e.osm !== 'string' || typeof e.importance !== 'number' || e.importance < 0 || e.importance > 1 || !Array.isArray(e.alt) || e.alt.some((a) => typeof a !== 'string') || (e.house != null && typeof e.house !== 'string')) throw new Error('Invalid gazetteer entry');
    if (!ids.has(e.id)) { ids.add(e.id); entries.push({ ...e, cat: e.type === 'poi' ? e.osm.split('/')[1] : e.type === 'house' ? 'address' : e.type, rank: e.importance * 100 }); }
  };
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; pending += value; let at; while ((at = pending.indexOf('\n')) >= 0) { line(pending.slice(0,at)); pending = pending.slice(at + 1); } if (pending.length > 1024 * 1024) throw new Error('Gazetteer line is too large'); } line(pending); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return entries;
}
/** Strict streaming ustar reader: checksum, bounds, paths and duplicate checks.
 * At most one artifact is buffered for WebCrypto; no whole-bundle inflate. */
export async function unpackBundle(blob: Blob): Promise<{ manifest: BundleManifest; artifacts: Map<string, Blob> }> {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let chunk = new Uint8Array(0), offset = 0;
  async function take(n: number): Promise<Uint8Array> {
    const result = new Uint8Array(n); let got = 0;
    while (got < n) {
      if (offset === chunk.length) { const r = await reader.read(); if (r.done) throw new Error('Truncated bundle'); chunk = r.value; offset = 0; }
      const len = Math.min(n - got, chunk.length - offset); result.set(chunk.subarray(offset, offset + len), got); got += len; offset += len;
    } return result;
  }
  const artifacts = new Map<string, Blob>(); let manifest: BundleManifest | null = null;
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, '');
  try {
    for (;;) {
      const h = await take(512); if (h.every((n) => n === 0)) break;
      const sum = h.reduce((n,v,i) => n + (i >= 148 && i < 156 ? 32 : v), 0);
      if (sum !== parseInt(text(h.subarray(148,156)).trim(),8) || text(h.subarray(257,263)) !== 'ustar') throw new Error('Invalid bundle tar header');
      const name = text(h.subarray(0,100)); const size = parseInt(text(h.subarray(124,136)).trim(),8);
      if (text(h.subarray(345,500)) || (h[156] !== 48 && h[156] !== 0) || !Number.isSafeInteger(size) || size < 0 || artifacts.has(name)) throw new Error('Unsafe bundle entry');
      if (name === 'manifest.json') {
        if (manifest || artifacts.size || size > 1024 * 1024) throw new Error('Manifest must be the first bundle entry');
        manifest = validateManifest(JSON.parse(new TextDecoder().decode(await take(size)))); await diskGate(manifest);
      } else {
        const a = manifest?.artifacts.find((a) => a.name === name);
        if (!a || a.bytes !== size) throw new Error('Unexpected artifact or size mismatch');
        const parts: ArrayBuffer[] = []; let left = size;
        while (left) { const b = await take(Math.min(left,1024 * 1024)); parts.push(b.buffer as ArrayBuffer); left -= b.length; }
        const file = new Blob(parts);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2,'0')).join('');
        if (hash !== a.sha256) throw new Error(`Checksum mismatch for ${name}`);
        artifacts.set(name,file);
      }
      if (size % 512) await take(512 - size % 512);
    }
    // Drain gzip to validate its CRC/trailer too. Only zero tar padding allowed.
    if (chunk.subarray(offset).some((b) => b !== 0)) throw new Error('Trailing data in bundle');
    for (;;) { const r = await reader.read(); if (r.done) break; if (r.value.some((b) => b !== 0)) throw new Error('Trailing data in bundle'); }
    if (!manifest || artifacts.size !== 3) throw new Error('Incomplete bundle');
    return { manifest, artifacts };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function metadata(m: BundleManifest, id: string, gaz: GazEntry[]): { meta: RegionMeta; dataset: OsmDataset } {
  return { meta: { id, name: m.region.name, code: 'service', bbox: m.region.bbox, counts: m.region.counts, bytes: m.artifacts.reduce((n,a) => n+a.bytes,0), loadedAt: Date.parse(m.build.created), gazetteerSize: gaz.length, buildId: m.build.id, inputHashes: m.inputs.map((i) => i.sha256) }, dataset: { gaz, bbox: m.region.bbox, counts: m.region.counts, roads: [], water: [], green: [], basemap: id, buildId: m.build.id } };
}
export async function importBundle(blob: Blob): Promise<Region> {
  const { manifest: m, artifacts } = await unpackBundle(blob);
  const { regionLib } = await import('./store');
  // Unique generation key: failed replacements cannot corrupt installed files.
  const id = `service-${m.build.id}-${crypto.randomUUID()}`;
  const gaz = await loadGazetteer(artifacts.get('search.gazetteer.jsonl.gz')!);
  const data = await artifacts.get('routing.valhalla.tar')!.arrayBuffer();
  const bytes = new Uint8Array(data);
  const tiles = parseTarIndex((into, at) => { const b = bytes.subarray(at,at+into.length); into.set(b); return b.length; },bytes.length).filter((e) => /^\d+\/(?:\d+\/)*\d+\.gph$/.test(e.name)).length;
  if (!tiles) throw new Error('Bundle contains no Valhalla routing tiles');
  const map = new Uint8Array(await artifacts.get('map.pmtiles')!.slice(0,127).arrayBuffer());
  if (new TextDecoder().decode(map.subarray(0,7)) !== 'PMTiles' || map[7] !== 3 || map[99] !== 1) throw new Error('Unsupported map archive');
  const info = { bytes: data.byteLength, tiles, buildId: m.build.id, inputHashes: m.inputs.map((i) => i.sha256) };
  try {
    await putArtifact(id,'search.gazetteer.jsonl.gz',artifacts.get('search.gazetteer.jsonl.gz')!);
    await putArtifact(id,'map.pmtiles',artifacts.get('map.pmtiles')!);
    await savePack(id,data,info);
    await getLocalValhalla().mount(id,data);
    await writeBundleRecord({ id, manifest: m }, id);
    const { meta, dataset } = metadata(m,id,gaz);
    const region = regionLib.add(meta,dataset); regionLib.setPack(id,info); return region;
  } catch (e) {
    await Promise.allSettled([getLocalValhalla().unmount(id),deleteArtifacts(id),deletePack(id),writeBundleRecord(null,id)]); throw e;
  }
}
export async function restoreBundles(): Promise<Region[]> {
  const { regionLib } = await import('./store'); const out: Region[] = [];
  for (const { id, manifest } of await bundleRecords()) {
    try { const m = validateManifest(manifest); const gaz = await loadGazetteer(await getArtifact(id,'search.gazetteer.jsonl.gz')); const { meta,dataset } = metadata(m,id,gaz); out.push(regionLib.add(meta,dataset)); }
    catch (e) { console.warn('Could not restore service region', id, e); }
  } return out;
}
