import { PMTiles, Protocol, type Source, type RangeResponse } from 'pmtiles';
import { readRange } from '../regions/artifactstore';
/** PMTiles asks for complete compressed tiles in one range. Cache that exact
 * range (including directory reads), coalescing concurrent identical requests. */
export class StoredMapSource implements Source {
  private cache = new Map<string, Promise<RangeResponse>>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  constructor(private id: string, private maxBytes = 16 * 1024 * 1024) {}
  getKey(): string { return `canopy-pack://${this.id}`; }
  clear(): void { this.cache.clear(); this.sizes.clear(); this.bytes = 0; }
  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    signal?.throwIfAborted();
    const key = `${offset}:${length}`;
    let value = this.cache.get(key);
    if (value) { this.cache.delete(key); this.cache.set(key,value); }
    else {
      value = readRange(this.id,'map.pmtiles',offset,length).then((data) => ({ data }));
      this.cache.set(key,value); this.sizes.set(key,length); this.bytes += length;
      while (this.bytes > this.maxBytes && this.cache.size > 1) {
        const oldest = this.cache.keys().next().value!; this.bytes -= this.sizes.get(oldest)!; this.sizes.delete(oldest); this.cache.delete(oldest);
      }
      value.catch(() => { if (this.cache.get(key) === value) { this.cache.delete(key); this.bytes -= this.sizes.get(key) ?? 0; this.sizes.delete(key); } });
    }
    const result = await value; signal?.throwIfAborted(); return result;
  }
}
const protocol = new Protocol();
let registered = false;
const archives = new Map<string, PMTiles>();
export function attachStoredMap(id: string, addProtocol: (name: string, handler: Protocol['tile']) => void): string {
  if (!registered) { addProtocol('pmtiles',protocol.tile); registered = true; }
  let archive = archives.get(id);
  if (!archive) { archive = new PMTiles(new StoredMapSource(id)); archives.set(id,archive); protocol.add(archive); }
  return `pmtiles://${archive.source.getKey()}`;
}
export function detachStoredMap(id: string): void {
  const archive = archives.get(id);
  if (!archive) return;
  if (archive.source instanceof StoredMapSource) archive.source.clear();
  // PMTiles exposes its protocol registry; deleting a removed region prevents
  // its whole-tile LRU from pinning storage buffers for the app's lifetime.
  protocol.tiles.delete(archive.source.getKey()); archives.delete(id);
}
