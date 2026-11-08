/**
 * The offline Valhalla engine: `tyr::actor_t` in-process over routing packs.
 *
 * This is the WASM engine measured in `research/valhalla-local-feasibility.md`
 * (§4.1: 1.4–1.7x native, a 739 km route in ~75 ms warm). It runs Valhalla's
 * real bidirectional A* with hierarchy and shortcut edges, and odin's real
 * maneuver generation — which is what makes it a replacement for the in-app
 * graph engine's inferred turn-by-turn rather than a parallel implementation.
 *
 * Tiles arrive as `PackSource`s (see `tilesource.ts`) and are mounted as lazy
 * virtual files at `/valhalla_tiles/<tile path>`: Valhalla's tile reader asks
 * for bytes, the source supplies them, and the engine's own LRU keeps the hot
 * parsed tiles. Nothing reads a pack end to end.
 *
 * The engine module (`valhalla.js` + `valhalla.wasm`, MIT, from
 * `ecc521/valhalla-wasm`) is UMD and loaded through an injected `loadModule`,
 * because the two hosts differ: a classic Worker `importScripts` the build,
 * Node `require`s it. Everything above the factory is host-agnostic.
 *
 * The mounting and config are adapted from `ecc521/valhalla-wasm`'s
 * `web/routingCore.ts` (MIT, (c) ecc521).
 */

import {
  parseValhallaTrip,
  buildValhallaRequestBody,
  RoutingError,
  type Route,
  type RouteRequest,
} from '../valhalla';
import { valhallaLocalConfig, type LocalValhallaConfigOptions } from './config';
import { wholeTileCached, type PackSource, type CachedPackSource } from './tilesource';

/* ------------------------------ module shape ----------------------------- */

/** The few `FS` calls mounting needs. Emscripten's, loosely typed on purpose. */
interface EmscriptenFS {
  mkdir(path: string): void;
  makedev(major: number, minor: number): number;
  registerDevice(dev: number, ops: Record<string, unknown>): void;
  mkdev(path: string, mode: number, dev: number): void;
  lookupPath(path: string): { node: Record<string, unknown> };
  unlink(path: string): void;
}

export interface ValhallaRouter {
  route(requestJson: string): string;
}

export interface ValhallaModule {
  FS: EmscriptenFS;
  ValhallaRouter: new (configJson: string) => ValhallaRouter;
}

/** The UMD factory: `ValhallaModule(moduleArg)` -> initialised module. */
export type ValhallaModuleFactory = (opts?: {
  locateFile?: (path: string) => string;
}) => Promise<ValhallaModule>;

/* ------------------------------- failures -------------------------------- */

/**
 * Failure sentences for the *offline* engine.
 *
 * `valhalla.ts`'s `describeRoutingFailure` speaks about "the routing server",
 * which for a pack on the device is a lie the driver cannot act on: there is no
 * server, no connection to check, no "try again in a moment". The codes are the
 * same engine's codes; the words are about the map the driver actually has.
 */
const LOCAL_ERRORS: Record<number, string> = {
  154: 'That trip is longer than the offline engine will plan. Split the trip, or use an online engine.',
  155: 'The offline engine cannot plan a route with no start or destination.',
  156: 'That trip is longer than the offline engine will plan. Split the trip, or use an online engine.',
  157: 'That route has more turns than the offline engine will plan. Split the trip into shorter legs.',
  160: 'The offline engine could not plan that route.',
  161: 'No road connects the start and destination in the offline map.',
  171: 'No route found between those points on the offline map. The roads may not be connected in this map.',
  172: 'The offline engine found no alternative routes.',
  442: 'The offline map has no road near the start or destination.',
  443: 'The destination is too close to the start to route.',
};

export function describeLocalFailure(code: number | null, raw: string): string {
  const known = code !== null ? LOCAL_ERRORS[code] : undefined;
  if (known) return known;
  const text = raw.toLowerCase();
  if (/suitable edges|snap|origin|destination/.test(text))
    return 'The offline map has no road near the start or destination.';
  if (/max distance|exceeds/.test(text))
    return 'That trip is too long for the offline engine to plan. Split the trip, or use an online engine.';
  if (/no path|no route|not connected|cannot find/.test(text))
    return 'No route found between those points on the offline map.';
  return 'The offline engine refused this route.';
}

/* ------------------------------- runtime --------------------------------- */

export interface ValhallaLocalRuntimeOptions extends LocalValhallaConfigOptions {
  /** Resolve `valhalla.wasm` (etc.) relative to the loaded `valhalla.js`. */
  locateFile?: (path: string) => string;
  /** Raw-tile cache per pack, bytes. See `tilesource.ts` for why it exists. */
  tileCacheBytes?: number;
}

interface Mounted {
  source: CachedPackSource;
  paths: string[];
}

export class ValhallaLocalRuntime {
  private module: ValhallaModule | null = null;
  private router: ValhallaRouter | null = null;
  private loading: Promise<ValhallaModule> | null = null;
  private mounted = new Map<string, Mounted>();
  private nextDeviceMajor = 80;

  constructor(
    private loadFactory: () => Promise<ValhallaModuleFactory>,
    private opts: ValhallaLocalRuntimeOptions = {},
  ) {}

  /** Regions currently mounted. */
  get regions(): string[] { return [...this.mounted.keys()]; }

  /** True once at least one pack is mounted: the engine can attempt a route. */
  get ready(): boolean { return this.mounted.size > 0; }

  private ensureModule(): Promise<ValhallaModule> {
    if (this.module) return Promise.resolve(this.module);
    if (!this.loading) {
      this.loading = this.loadFactory().then((factory) =>
        factory(this.opts.locateFile ? { locateFile: this.opts.locateFile } : undefined),
      ).then((mod) => {
        this.module = mod;
        try { mod.FS.mkdir('/valhalla_tiles'); } catch { /* exists */ }
        return mod;
      }).catch((e) => {
        this.loading = null;
        throw e;
      });
    }
    return this.loading;
  }

  /**
   * Mount a pack under `region`.
   *
   * Remounting the same region replaces it wholesale — a re-imported pack must
   * not leave stale tiles answering routes. The router is rebuilt whenever the
   * mounted set changes: Valhalla's actor resolves tile paths at construction,
   * and a router that outlives its tiles is a router answering from ghosts.
   */
  async mount(region: string, source: PackSource): Promise<void> {
    const mod = await this.ensureModule();
    this.detach(region);
    const cached = wholeTileCached(source, { maxBytes: this.opts.tileCacheBytes });
    const paths = this.mountTiles(mod.FS, cached);
    this.mounted.set(region, { source: cached, paths });
    this.router = null;
  }

  unmount(region: string): void {
    if (!this.mounted.has(region)) return;
    this.detach(region);
    this.router = null;
  }

  /** One route. Throws `RoutingError` with offline-worded messages. */
  async route(req: RouteRequest): Promise<Route> {
    const router = this.ensureRouter(await this.ensureModule());
    const units = req.units ?? 'km';
    const raw = router.route(JSON.stringify(buildValhallaRequestBody(req, units)));

    let json: { error?: string; error_code?: number; status_code?: number };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new RoutingError(
        'The offline engine returned an answer this app could not read.',
        undefined,
        raw.slice(0, 200),
      );
    }
    if (json.error || typeof json.error_code === 'number') {
      const code = typeof json.error_code === 'number'
        ? json.error_code
        : typeof json.status_code === 'number' ? json.status_code : null;
      const detail = (json.error ?? '').trim() || 'no detail';
      throw new RoutingError(describeLocalFailure(code, detail), undefined, detail);
    }
    // Same parser as the hosted client: same failure sentences for corrupt
    // geometry, same metre normalisation, real maneuvers either way.
    return parseValhallaTrip(json, units, 'valhalla-local');
  }

  dispose(): void {
    for (const region of [...this.mounted.keys()]) this.unmount(region);
    this.module = null;
    this.router = null;
    this.loading = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private ensureRouter(mod: ValhallaModule): ValhallaRouter {
    if (!this.router) {
      this.router = new mod.ValhallaRouter(JSON.stringify(valhallaLocalConfig(this.opts)));
    }
    return this.router;
  }

  /**
   * Forget a region's tiles and unmount its virtual files.
   *
   * Order matters and was once wrong: deleting the registry entry first and
   * *then* looking it up to unlink the files found nothing, so "unmounted"
   * packs kept routing. A test caught it (`valhalla-local.spec.ts`, "is done
   * with a region after unmount") — which is exactly what the test is for.
   */
  private detach(region: string): void {
    const m = this.mounted.get(region);
    if (!m) return;
    this.mounted.delete(region);
    if (!this.module) return;
    for (const p of m.paths) {
      // A tile path can be shared when two packs overlap (they should not —
      // packs are partitions of one build, see research §6 — but a duplicate
      // mount must not tear the tile out from under the pack that also has it).
      const ownedElsewhere = [...this.mounted.values()].some((other) => other.paths.includes(p));
      if (ownedElsewhere) continue;
      try { this.module.FS.unlink(p); } catch { /* already gone */ }
    }
  }

  /**
   * Register every tile as a lazily-read virtual file.
   *
   * Adapted from ecc521/valhalla-wasm's `mountTileSource`: each tile becomes a
   * character device patched to look like a regular file, and its `read` pulls
   * bytes from the source only when Valhalla actually asks. Combined with the
   * engine's LRU and `wholeTileCached`, a tile crosses from storage at most
   * once per eviction window.
   */
  private mountTiles(fs: EmscriptenFS, source: PackSource): string[] {
    const major = this.nextDeviceMajor++;
    let minor = 0;
    const ops = {
      open(stream: { seekable: boolean; node: Record<string, unknown> } & Record<string, unknown>) {
        stream.seekable = true;
        stream.tileOffset = stream.node.tileOffset;
        stream.tileSize = stream.node.tileSize;
      },
      read(
        stream: Record<string, unknown>,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) {
        const tileOffset = stream.tileOffset as number;
        const tileSize = stream.tileSize as number;
        const remaining = tileSize - position;
        if (remaining <= 0) return 0;
        const toRead = Math.min(length, remaining);
        const target = buffer.subarray(offset, offset + toRead);
        return source.read(target, tileOffset + position);
      },
      write() { throw new Error('Routing packs are read-only.'); },
      llseek(stream: Record<string, unknown>, offset: number, whence: number) {
        const tileSize = stream.tileSize as number;
        if (whence === 1) return (stream.position as number) + offset;
        if (whence === 2) return tileSize + offset;
        return offset;
      },
    };

    const paths: string[] = [];
    for (const entry of source.entries) {
      const clean = entry.name.replace(/^\.\//, '');
      const filePath = `/valhalla_tiles/${clean}`;
      // Already mounted by another pack: skip rather than double-mount. Packs
      // are partitions of one build so this should not happen; if it does, the
      // pack that mounted first owns the tile (see `unmountFiles`).
      try { fs.lookupPath(filePath); continue; } catch { /* not mounted yet */ }
      mkdirp(fs, filePath.substring(0, filePath.lastIndexOf('/')));
      const dev = fs.makedev(major, minor++);
      fs.registerDevice(dev, ops);
      fs.mkdev(filePath, 0o644, dev);
      const { node } = fs.lookupPath(filePath);
      // S_IFREG so stat() reports a regular file, with the body's true size.
      node.mode = 0o100644;
      node.usedBytes = entry.size;
      node.size = entry.size;
      node.tileOffset = entry.offset;
      node.tileSize = entry.size;
      paths.push(filePath);
    }
    return paths;
  }
}

function mkdirp(fs: EmscriptenFS, dirPath: string): void {
  let current = '';
  for (const part of dirPath.split('/').filter(Boolean)) {
    current += '/' + part;
    try { fs.mkdir(current); } catch { /* exists */ }
  }
}
