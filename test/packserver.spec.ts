import 'fake-indexeddb/auto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { unpackBundle, validateManifest, loadGazetteer, importBundle, diskGate } from '../src/regions/bundle';
import { PackService, serviceAddress, isInsecureTransport, validateUploads, uploadSizeNote, explainFailure } from '../src/regions/service';
import { readPackService, writePackService } from '../src/settings';
import { scoreGazetteer } from '../src/search/gaz';
import { searchContext, searchType } from '../src/search/types';
import { planRoute } from '../src/nav/engines';
import { resolveRoute } from '../src/nav/providers';
import { InProcessClient } from '../src/nav/valhalla-local/client';
import { loadNodeFactory } from '../src/nav/valhalla-local/node';
import { parseTarIndex } from '../src/nav/valhalla-local/tar';
import { offlineStyleSpec, navOverlays, OSM_ATTRIBUTION } from '../src/map/style';
import { StoredMapSource } from '../src/map/pmtiles';
import { regionLib, removeRegion } from '../src/regions/store';
import type { GazEntry } from '../src/search/gaz';

const storage = vi.hoisted(() => ({ files: new Map<string,Blob>(), mount: vi.fn(async () => {}), unmount: vi.fn(async () => {}) }));
vi.mock('../src/regions/artifactstore', () => ({
  putArtifact: vi.fn(async (id:string,n:string,b:Blob) => { storage.files.set(`${id}/${n}`,b); }),
  getArtifact: vi.fn(async (id:string,n:string) => storage.files.get(`${id}/${n}`)),
  deleteArtifacts: vi.fn(async (id:string) => { for (const k of storage.files.keys()) if (k.startsWith(`${id}/`)) storage.files.delete(k); }),
  readRange: vi.fn(async (id:string,n:string,o:number,l:number) => storage.files.get(`${id}/${n}`)!.slice(o,o+l).arrayBuffer()),
}));
vi.mock('../src/nav/valhalla-local', async (original) => ({ ...await original<object>(), getLocalValhalla: () => ({ mount: storage.mount, unmount: storage.unmount }) }));
const fixture = (name:string) => readFileSync(new URL(`./packserver/${name}`,import.meta.url));
const blob = (name:string) => new Blob([fixture(name)]);

describe('Rust-produced bundle / JS contracts', () => {
  it('unpacks and verifies every artifact with the app reader', async () => {
    const { manifest,artifacts } = await unpackBundle(blob('fixture.tar.gz'));
    expect(manifest.format).toBe('canopy-bundle/1'); expect(artifacts.size).toBe(3);
    for (const [name,data] of artifacts) expect(Buffer.from(await data.arrayBuffer())).toEqual(fixture(name));
  });
  it('loads exact real test addresses, multilingual variants and fuzzy matches without a cap', async () => {
    const gaz = await loadGazetteer(blob('search.gazetteer.jsonl.gz'));
    expect(gaz.every((e) => e.id && e.importance != null && e.alt)).toBe(true);
    const hit = scoreGazetteer(gaz,'123 main')[0].entry;
    expect(hit.house).toBe('123'); expect(hit.street).toBe('Main Street'); expect(hit.city).toBe('Fixture City');
    expect(scoreGazetteer(gaz,'blue yondr')[0].entry.name).toBe('Blue Yonder Cafe');
    expect(gaz.filter((e) => e.house != null)).toHaveLength(1);
    expect(scoreGazetteer(gaz,'main street').length).toBeGreaterThan(0);
  });
  it('reads header, metadata, Hilbert directory and an actual MVT tile with npm pmtiles', async () => {
    const bytes = fixture('map.pmtiles');
    const pm = new PMTiles({ getKey: () => 'fixture', getBytes: async (offset,length) => ({ data: bytes.subarray(offset,offset+length).buffer.slice(bytes.byteOffset+offset,bytes.byteOffset+Math.min(bytes.length,offset+length)) as ArrayBuffer }) });
    const h = await pm.getHeader(); expect(h.specVersion).toBe(3); expect(h.tileType).toBe(1); expect(h.rootDirectoryLength).toBeLessThanOrEqual(16257);
    const meta = await pm.getMetadata() as { vector_layers: { id:string }[]; attribution:string };
    expect(meta.vector_layers.map((l) => l.id)).toEqual(['roads','water','green']); expect(meta.attribution).toContain('OpenStreetMap');
    const z = 13, x = Math.floor((-1.39+180)/360*2**z), y = Math.floor((1-Math.asinh(Math.tan(51.5*Math.PI/180))/Math.PI)/2*2**z);
    const tile = await pm.getZxy(z,x,y); expect(tile?.data.byteLength).toBeGreaterThan(10); expect(zxyToTileId(1,1,0)).toBe(4);
  });
  it('accepts the portable vector style and displays required attribution', () => {
    const style = offlineStyleSpec(navOverlays(),'pmtiles://canopy-pack://test');
    expect(validateStyleMin(style)).toEqual([]);
    expect(style.sources['canopy-basemap']).toMatchObject({ type: 'vector', attribution: OSM_ATTRIBUTION });
    expect(style.layers.filter((l) => 'source-layer' in l).map((l) => l['source-layer'])).toContain('roads');
    expect(offlineStyleSpec(navOverlays()).sources['canopy-osm'].type).toBe('geojson');
  });
  it('refuses unknown, duplicated and traversal artifacts before ingestion', () => {
    const m = JSON.parse(fixture('manifest.json').toString());
    expect(() => validateManifest({ ...m,format:'canopy-bundle/2' })).toThrow();
    m.artifacts[0].name='../keys.json'; expect(() => validateManifest(m)).toThrow();
    m.artifacts[0] = { name:'__proto__',bytes:1,sha256:'0'.repeat(64) };
    expect(() => validateManifest(m)).toThrow('Invalid bundle artifact');
  });
  it('detects tampering, tar truncation and trailing non-padding bytes', async () => {
    const tar = gunzipSync(fixture('fixture.tar.gz')); const index = parseTarIndex((into,at) => { const b = tar.subarray(at,at+into.length); into.set(b); return b.length; },tar.length);
    const e = index.find((e) => e.name === 'map.pmtiles')!;tar[e.offset+127] ^= 1;
    await expect(unpackBundle(new Blob([gzipSync(tar)]))).rejects.toThrow('Checksum mismatch');
    await expect(unpackBundle(new Blob([fixture('fixture.tar.gz').subarray(0,100)]))).rejects.toThrow();
  });
  it('gates on exact artifact disk sizes before downloading', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis,'navigator');
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async () => ({quota:10,usage:0})}}});
    try { await expect(diskGate(validateManifest(JSON.parse(fixture('manifest.json').toString())))).rejects.toThrow('Not enough storage'); }
    finally { if (previous) Object.defineProperty(globalThis,'navigator',previous); else Reflect.deleteProperty(globalThis,'navigator'); }
  });
  it('persists an unpacked service region with no graph, and removes all stores', async () => {
    const r = await importBundle(blob('fixture.tar.gz'));
    expect(r.dataset.graph).toBeUndefined();expect(r.dataset.basemap).toBe(r.id);expect(r.pack?.tiles).toBeGreaterThan(0);expect(storage.mount).toHaveBeenCalled();
    expect(storage.files.has(`${r.id}/map.pmtiles`)).toBe(true);expect(regionLib.routeIn(r,[-1.4,51.5],[-1.39,51.5])).toBeNull();
    await removeRegion(r.id);expect([...storage.files.keys()].some((k) => k.startsWith(`${r.id}/`))).toBe(false);
  });
  it('coalesces and caches complete tile ranges', async () => {
    const { readRange } = await import('../src/regions/artifactstore'); vi.mocked(readRange).mockClear();
    storage.files.set('cached/map.pmtiles',blob('map.pmtiles'));const source = new StoredMapSource('cached');
    const [a,b] = await Promise.all([source.getBytes(0,127),source.getBytes(0,127)]);expect(a).toBe(b);expect(readRange).toHaveBeenCalledTimes(1);
  });
});

describe('service region routing policy', () => {
  let client:InProcessClient;
  beforeAll(async () => {client = new InProcessClient({loadFactory:loadNodeFactory}); const {artifacts}=await unpackBundle(blob('fixture.tar.gz')); await client.mount('fixture',await artifacts.get('routing.valhalla.tar')!.arrayBuffer());},60000);
  afterAll(() => client.dispose());
  it('routes server artifacts with WASM and real odin maneuvers', async () => {
    const out = await client.route({from:[-1.4,51.5],to:[-1.3232,51.506]});expect(out.engine).toBe('valhalla-local');expect(out.maneuvers.length).toBeGreaterThanOrEqual(2);
  });
  it('does not offer A* for pack-backed regions even if explicitly selected', () => {
    expect(planRoute({preferred:'local-valhalla',allowFallback:true},{packBacked:true})).not.toContain('local');
    expect(planRoute({preferred:'local',allowFallback:false},{packBacked:true})).toEqual([]);
  });
  it('refuses explicit A* requests against a service dataset', async () => {
    const dataset = {gaz:[],roads:[],water:[],green:[],bbox:[-2,50,0,52] as [number,number,number,number],counts:{nodes:0,ways:0,routable:0},buildId:'bld_fixture'};
    await expect(resolveRoute({from:[-1.4,51.5],to:[-1.39,51.5],provider:'local',plan:['local'],strict:true},dataset,{})).rejects.toThrow();
  });
});

describe('Photon presentation and ranking inputs', () => {
  it('matches alphanumeric house numbers and alternate names', () => {
    const e:GazEntry = {name:'12A Rue Principale',cat:'address',rank:10,type:'house',house:'12A',street:'Rue Principale',lat:0,lon:0,alt:['12A Main Street']};
    expect(scoreGazetteer([e],'12a main')[0]?.entry).toBe(e);
  });
  it('uses importance before location bias without changing legacy constants', () => {
    const entries = [0.2,0.8].map((importance) => ({name:'Springfield',cat:'city',rank:0,importance,lon:0,lat:0}));
    expect(scoreGazetteer(entries,'springfield',[0,0])[0].entry.importance).toBe(0.8);
    expect(scoreGazetteer([{name:'Main',cat:'street',rank:55,lon:0,lat:0}],'main')[0].score).toBe(1055);
  });
  it('exposes admin context and the unified type vocabulary', () => {
    const e = {name:'Main',cat:'street',type:'street',rank:0,lat:0,lon:0,city:'Calgary',state:'Alberta',country:'Canada'};
    expect(searchContext(e,'fallback')).toBe('Street · Calgary · Alberta · Canada');expect(searchType(e).icon).toBe('street');
  });
});

describe('configured service client', () => {
  it('requires both address and key; accepts HTTPS and self-hosted HTTP, flagging clear text', () => {
    expect(() => serviceAddress({url:'',apiKey:'key'})).toThrow();expect(() => serviceAddress({url:'https://[2001:db8::1]',apiKey:''})).toThrow();
    expect(serviceAddress({url:'https://[2001:db8::1]',apiKey:'key'}).hostname).toBe('[2001:db8::1]');
    // Self-hosted HTTP is allowed by explicit choice (LAN / TLS terminated
    // elsewhere), but it sends the key in clear text and is flagged as such.
    const clear = serviceAddress({url:'http://[2001:db8::1]',apiKey:'key'});
    expect(clear.protocol).toBe('http:');
    expect(isInsecureTransport(clear)).toBe(true);
    expect(isInsecureTransport(serviceAddress({url:'https://[2001:db8::1]',apiKey:'key'}))).toBe(false);
    expect(isInsecureTransport(serviceAddress({url:'http://[::1]:8787',apiKey:'key'}))).toBe(false);
    expect(() => serviceAddress({url:'ftp://[2001:db8::1]',apiKey:'key'})).toThrow('HTTP(S)');
  });
  it('stores credentials device-locally, separately from routing credentials', () => {
    const data = new Map<string,string>();const store={getItem:(k:string) => data.get(k) ?? null,setItem:(k:string,v:string) => {data.set(k,v);},removeItem:(k:string) => {data.delete(k);}};
    expect(writePackService({url:' https://packs.example.org ',apiKey:' secret '},store)).toBeNull();expect(readPackService(store)).toEqual({url:'https://packs.example.org',apiKey:'secret'});
  });
  it('sends the key only to the configured origin and refuses redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({id:'bld_test',state:'done'})));
    const client = new PackService({url:'https://packs.example.org',apiKey:'secret'},fetcher as typeof fetch);
    await client.status('bld_test');expect(fetcher).toHaveBeenCalledWith('https://packs.example.org/v1/builds/bld_test',expect.objectContaining({redirect:'error',credentials:'omit',headers:{'X-API-Key':'secret'}}));
    await expect(client.status('../admin')).rejects.toThrow('Invalid build id');
  });
  it('surfaces async failures and aborts polling', async () => {
    const client = new PackService({url:'https://packs.example.org',apiKey:'secret'},vi.fn(async () => new Response(JSON.stringify({state:'failed',error:{message:'PBF not sorted'}}))) as typeof fetch);
    await expect(client.poll('bld_test')).rejects.toThrow('PBF not sorted');
    const ctrl = new AbortController();ctrl.abort();await expect(client.poll('bld_test',{signal:ctrl.signal})).rejects.toThrow();
  });
});

/** The slice of XMLHttpRequest the upload client drives, faked for the unit tests. */
class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  status = 0; responseText = ''; responseURL = ''; aborted = false;
  requestHeaders: Record<string,string> = {}; responseHeaders: Record<string,string> = {};
  method = ''; url = ''; body: FormData | null = null;
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.requestHeaders[name] = value; }
  getResponseHeader(name: string) { return this.responseHeaders[name] ?? null; }
  send(body: FormData) { this.body = body; FakeXHR.last = this; }
  abort() { this.aborted = true; this.onabort?.(); }
  respond(status: number, body: unknown, headers: Record<string,string> = {}, at = this.url) {
    this.status = status; this.responseText = JSON.stringify(body); this.responseHeaders = headers; this.responseURL = at; this.onload?.();
  }
}
const pbf = (name: string, bytes = 4) => new File([new Uint8Array(bytes)], name);
const uploads: FakeXHR[] = [];
const uploadClient = (fetcher: typeof fetch = vi.fn(async () => new Response('{}'))) =>
  new PackService({url:'https://packs.example.org',apiKey:'secret'}, fetcher, () => { const x = new FakeXHR(); uploads.push(x); return x as unknown as XMLHttpRequest; });

describe('pack service upload', () => {
  it('preflights the filename rules the server enforces, before any bytes move', () => {
    expect(() => validateUploads([])).toThrow('Choose one or more .osm.pbf files');
    expect(() => validateUploads([pbf('region.osm'), pbf('a.osm.pbf')])).toThrow('not a .osm.pbf extract');
    expect(() => validateUploads([pbf('../a.osm.pbf')])).toThrow('not a filename');
    expect(() => validateUploads([pbf('a.osm.pbf'), pbf('b.osm.pbf'), pbf('a.osm.pbf')])).toThrow('both called');
    expect(() => validateUploads(Array.from({length: 129},(_,i) => pbf(`f${i}.osm.pbf`)))).toThrow('at most 128');
    expect(validateUploads([pbf('alberta-latest.osm.pbf')])).toHaveLength(1);
  });
  it('advises on the default upload cap without refusing smaller sends', () => {
    expect(uploadSizeNote([pbf('a.osm.pbf')])).toBeNull();
    // Only `size` is read, so no multi-gigabyte buffer is allocated to test it.
    expect(uploadSizeNote([{ name: 'a.osm.pbf', size: 2.5 * 1024 * 1024 * 1024 }] as unknown as File[])).toContain('PACKSERVER_MAX_UPLOAD_MB');
  });
  it('submits the extracts as one multipart build request and returns the build id', async () => {
    const client = uploadClient();
    const promise = client.submit([pbf('alberta-latest.osm.pbf'),pbf('saskatchewan-latest.osm.pbf')],{ region: 'prairies' });
    const x = FakeXHR.last!;
    expect(x.method).toBe('POST'); expect(x.url).toBe('https://packs.example.org/v1/builds');
    expect(x.requestHeaders).toEqual({ 'X-API-Key': 'secret' });
    expect((x.body!.getAll('file') as File[]).map((f) => f.name)).toEqual(['alberta-latest.osm.pbf','saskatchewan-latest.osm.pbf']);
    expect(x.body!.get('region')).toBe('prairies');
    x.respond(202,{ id: 'bld_test',state: 'queued' });
    await expect(promise).resolves.toEqual({ id: 'bld_test' });
  });
  it('reports upload progress and cancels the send', async () => {
    const client = uploadClient(); const seen: number[] = [];
    const ctrl = new AbortController();
    const promise = client.submit([pbf('a.osm.pbf')],{ signal: ctrl.signal,onProgress: (p) => seen.push(p.sent) });
    const x = FakeXHR.last!;
    x.upload.onprogress?.({ loaded: 5,total: 10,lengthComputable: true } as ProgressEvent);
    expect(seen).toEqual([5]);
    ctrl.abort();
    expect(x.aborted).toBe(true);
    await expect(promise).rejects.toThrow();
  });
  it('translates refusals into what the driver can do, keeping the server words', async () => {
    expect(explainFailure(401,{error:{code:'unauthorized',message:'Unknown key'}})).toMatch(/rejected the API key.*Unknown key/);
    expect(explainFailure(413,{error:{code:'too_large',message:'Upload exceeds configured body cap'}})).toContain('osmium extract');
    expect(explainFailure(422,{error:{code:'input_unsorted',message:'PBF not sorted'}})).toContain('osmium sort');
    expect(explainFailure(422,{error:{code:'input_not_pbf',message:'Each file must have a safe .osm.pbf filename'}})).toContain('safe .osm.pbf filename');
    expect(explainFailure(429,{error:{code:'rate_limited',message:'Slow down'}})).toContain('Try again later');
    expect(explainFailure(429,{error:{code:'rate_limited'}},'3600')).toContain('about 60 minutes');
    const client = uploadClient(vi.fn(async () => new Response(JSON.stringify({error:{code:'unauthorized',message:'Unknown key'}}),{ status: 401 })) as typeof fetch);
    await expect(client.status('bld_test')).rejects.toThrow('rejected the API key');
  });
  it('refuses a redirected response and an invalid build id rather than trusting them', async () => {
    const client = uploadClient();
    const redirected = client.submit([pbf('a.osm.pbf')]);
    FakeXHR.last!.respond(202,{ id: 'bld_test' },{},'https://evil.example.net/v1/builds');
    await expect(redirected).rejects.toThrow('redirected');
    const malformed = client.submit([pbf('a.osm.pbf')]);
    FakeXHR.last!.respond(202,{ id: '../admin' });
    await expect(malformed).rejects.toThrow('Invalid build id');
  });
});
