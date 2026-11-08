/**
 * The offline Valhalla engine, app-wide.
 *
 * One instance for the whole app: routing packs outlive screens, and a second
 * engine would mean a second WASM instance and a second copy of every pack.
 * The instance is created lazily and loads nothing until a pack is mounted, so
 * an app with no packs pays for none of this — not even the worker.
 */

import { createLocalValhalla, type LocalValhallaClient } from './client';

export { createLocalValhalla, InProcessClient, type LocalValhallaClient } from './client';
export { ValhallaLocalRuntime, describeLocalFailure, type ValhallaModuleFactory } from './runtime';
export {
  arrayBufferSource,
  wholeTileCached,
  DEFAULT_TILE_CACHE_BYTES,
  type PackSource,
  type CachedPackSource,
  type CacheStats,
} from './tilesource';
export { parseTarIndex, type TarEntry, type ByteRead } from './tar';
export type { WorkerRequest, WorkerResponse } from './protocol';

let instance: LocalValhallaClient | null = null;

/** The app's engine. Never loads WASM or starts a worker until used. */
export function getLocalValhalla(): LocalValhallaClient {
  if (!instance) instance = createLocalValhalla();
  return instance;
}

/** Replace the singleton — tests hand in an in-process engine. */
export function setLocalValhalla(client: LocalValhallaClient | null): void {
  instance?.dispose();
  instance = client;
}
