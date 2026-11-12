/**
 * The offline Valhalla engine, as the rest of the app sees it.
 *
 * Two transports behind one interface:
 *
 *  - **worker** — the engine runs in a classic Worker (see `worker.ts`). This
 *    is the app's path: a route is tens of milliseconds of WASM on a good day
 *    and a second on a cold long corridor, and none of it may stutter the map.
 *    Packs are *transferred* to the worker (structured clone with move
 *    semantics), so the main thread never holds a pack it cannot read.
 *  - **in-process** — the engine runs in the caller's thread against injected
 *    pack sources. This is what the test suite drives: the same runtime, the
 *    same tiles, no worker machinery to fake.
 *
 * `ready()` answers "could a route even be attempted" — at least one pack is
 * mounted — because `providers.ts` consults it *before* choosing an engine, and
 * that decision is synchronous.
 */

import { RoutingError, type Route, type RouteRequest } from '../valhalla';
import { ValhallaLocalRuntime, type ValhallaModuleFactory } from './runtime';
import { arrayBufferSource, type PackSource } from './tilesource';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface LocalValhallaClient {
  /** At least one routing pack is mounted: a route is worth attempting. */
  ready(): boolean;
  /** Regions with mounted packs. */
  regions(): string[];
  /**
   * Mount (or replace) a region's routing pack.
   *
   * The worker transport takes ownership of the buffer (it is transferred);
   * pass a buffer nothing else holds.
   */
  mount(region: string, pack: ArrayBuffer | Uint8Array): Promise<void>;
  unmount(region: string): Promise<void>;
  route(req: RouteRequest): Promise<Route>;
  dispose(): void;
}

/* ------------------------------- worker ---------------------------------- */

export class WorkerClient implements LocalValhallaClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private mounted = new Set<string>();

  private ensureWorker(): Worker {
    if (!this.worker) {
      // Module worker: works identically in dev (where Vite serves worker
      // sources as ESM) and in the built bundle. The engine build is UMD and
      // the worker loads it either way — see `worker.ts`'s dual loader.
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.seq);
        if (!p) return;
        this.pending.delete(e.data.seq);
        p.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        const err = new Error(`Offline routing worker failed: ${e.message ?? 'unknown error'}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(msg.seq, { resolve, reject });
      worker.postMessage(msg, transfer);
    });
  }

  ready(): boolean { return this.mounted.size > 0; }
  regions(): string[] { return [...this.mounted]; }

  async mount(region: string, pack: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = toArrayBuffer(pack);
    const res = await this.send({ type: 'mount', seq: ++this.seq, region, bytes }, [bytes]);
    if (res.type === 'error') throw new RoutingError(res.message, res.status, res.detail);
    this.syncRegions(res.regions);
  }

  async unmount(region: string): Promise<void> {
    if (!this.mounted.has(region)) return;
    const res = await this.send({ type: 'unmount', seq: ++this.seq, region });
    if (res.type === 'error') throw new RoutingError(res.message, res.status, res.detail);
    this.syncRegions(res.regions);
  }

  async route(req: RouteRequest): Promise<Route> {
    const res = await this.send({ type: 'route', seq: ++this.seq, request: req });
    if (res.type === 'error') {
      throw res.detail !== undefined || res.status !== undefined
        ? new RoutingError(res.message, res.status, res.detail)
        : new RoutingError(res.message);
    }
    return res.route!;
  }

  dispose(): void {
    if (this.worker) {
      // Terminating is also the cancel: an in-flight WASM search cannot be
      // interrupted politely, and a disposed engine is one the app has stopped
      // caring about. The next route re-creates the worker and re-mounts.
      this.worker.terminate();
      this.worker = null;
    }
    for (const p of this.pending.values()) p.reject(new RoutingError('Offline routing engine was disposed'));
    this.pending.clear();
    this.mounted.clear();
  }

  private syncRegions(regions: string[] | undefined): void {
    if (regions) this.mounted = new Set(regions);
  }
}

/* ----------------------------- in-process -------------------------------- */

export interface InProcessOptions {
  /** How to obtain the engine module. Tests inject; Node defaults to `node.ts`. */
  loadFactory?: () => Promise<ValhallaModuleFactory>;
  /** Sources per region, for mounts that arrive as already-indexed packs. */
  sourceFor?: (region: string) => PackSource;
  tileCacheBytes?: number;
  maxCacheBytes?: number;
}

class InProcessClient implements LocalValhallaClient {
  private runtime: ValhallaLocalRuntime;

  constructor(opts: InProcessOptions = {}) {
    const loadFactory = opts.loadFactory ?? defaultNodeFactory;
    this.runtime = new ValhallaLocalRuntime(loadFactory, {
      tileCacheBytes: opts.tileCacheBytes,
      maxCacheBytes: opts.maxCacheBytes,
    });
    this.sourceFor = opts.sourceFor ?? ((_, pack) => arrayBufferSource(pack!));
  }

  private sourceFor: (region: string, pack?: ArrayBuffer | Uint8Array) => PackSource;

  ready(): boolean { return this.runtime.ready; }
  regions(): string[] { return this.runtime.regions; }

  async mount(region: string, pack: ArrayBuffer | Uint8Array): Promise<void> {
    await this.runtime.mount(region, this.sourceFor(region, pack));
  }

  /** Mount an already-indexed source — how tests attach instrumented packs. */
  async mountSource(region: string, source: PackSource): Promise<void> {
    await this.runtime.mount(region, source);
  }

  async unmount(region: string): Promise<void> {
    this.runtime.unmount(region);
  }

  route(req: RouteRequest): Promise<Route> { return this.runtime.route(req); }

  dispose(): void { this.runtime.dispose(); }
}

export { InProcessClient };

/**
 * The Node module loader, imported lazily so the browser bundle never tries to
 * resolve `node:module`. Only the in-process transport in a non-worker host
 * reaches this, which in practice means the test suite.
 */
async function defaultNodeFactory(): Promise<ValhallaModuleFactory> {
  const spec = './node.js';
  const mod = (await import(/* @vite-ignore */ spec)) as { loadNodeFactory: () => Promise<ValhallaModuleFactory> };
  return mod.loadNodeFactory();
}

/* ------------------------------- factory --------------------------------- */

export function createLocalValhalla(
  opts: InProcessOptions & { kind?: 'worker' | 'in-process' } = {},
): LocalValhallaClient {
  const kind = opts.kind ?? (typeof Worker !== 'undefined' ? 'worker' : 'in-process');
  return kind === 'worker' ? new WorkerClient() : new InProcessClient(opts);
}

/** Exactly one buffer for a pack, whatever shape the caller holds. */
function toArrayBuffer(pack: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (pack instanceof ArrayBuffer) return pack;
  if (pack.byteOffset === 0 && pack.byteLength === pack.buffer.byteLength) {
    return pack.buffer as ArrayBuffer;
  }
  return pack.slice().buffer as ArrayBuffer;
}
