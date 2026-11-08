/**
 * The offline Valhalla worker.
 *
 * Protocol glue around `runtime.ts`. The engine computes synchronously inside
 * `route()` (one message at a time), so a route never interleaves with another
 * — the queue is the browser's message queue.
 *
 * The engine build (`valhalla.js`) is UMD, and UMD has no home in a module
 * worker — `importScripts` is classic-only and importing the file as ESM
 * exports nothing. The dual loader below runs it correctly in both kinds of
 * worker without `eval` (which a CSP need not allow):
 *
 *  - classic worker: `importScripts`, the host behaviour the build was made
 *    for, defines `ValhallaModule` on the worker global;
 *  - module worker: the same script is *imported*, with `module`/`exports`
 *    pre-declared on the global so the UMD tail's `module.exports =
 *    ValhallaModule` lands somewhere reachable. Unqualified `typeof module`
 *    sees the global, so the tail takes its CommonJS branch.
 */

/// <reference lib="webworker" />

import { ValhallaLocalRuntime, type ValhallaModuleFactory } from './runtime';
import { arrayBufferSource } from './tilesource';
import { RoutingError } from '../valhalla';
import type { WorkerRequest, WorkerResponse } from './protocol';
import valhallaJsUrl from 'valhalla-wasm/valhalla.js?url';
import valhallaWasmUrl from 'valhalla-wasm/valhalla.wasm?url';

declare const self: DedicatedWorkerGlobalScope & {
  importScripts?: (...urls: string[]) => void;
  ValhallaModule?: ValhallaModuleFactory;
  module?: { exports: ValhallaModuleFactory | { default?: ValhallaModuleFactory } };
  exports?: unknown;
};

const runtime = new ValhallaLocalRuntime(
  async (): Promise<ValhallaModuleFactory> => {
    // Tried rather than feature-detected: in a *module* worker `importScripts`
    // exists as a function and throws "Module scripts don't support
    // importScripts()" when called. A try is the only honest probe.
    if (typeof self.importScripts === 'function') {
      try {
        self.importScripts(valhallaJsUrl);
        if (self.ValhallaModule) return self.ValhallaModule;
      } catch { /* module worker; fall through */ }
    }
    // Module worker: give the UMD tail a `module.exports` to fill, then
    // import the script as a module (its top-level `var` is module-scoped, so
    // the export *is* the tail's assignment).
    const g = self as unknown as Record<string, unknown>;
    const holder: { exports: unknown } = { exports: {} };
    g.module = holder;
    g.exports = holder.exports;
    const spec = valhallaJsUrl;
    await import(/* @vite-ignore */ spec);
    const out = holder.exports as ValhallaModuleFactory | { default?: ValhallaModuleFactory };
    const factory = typeof out === 'function' ? out : out?.default;
    if (!factory) throw new Error('valhalla.js did not yield ValhallaModule');
    return factory;
  },
  { locateFile: (p) => (p.endsWith('.wasm') ? valhallaWasmUrl : p) },
);

function reply(r: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer?.length) self.postMessage(r, transfer);
  else self.postMessage(r);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  void (async () => {
    try {
      switch (msg.type) {
        case 'mount':
          // The buffer arrives transferred; it is the pack and nothing aliases it.
          await runtime.mount(msg.region, arrayBufferSource(msg.bytes));
          reply({ type: 'ok', seq: msg.seq, regions: runtime.regions });
          break;
        case 'unmount':
          runtime.unmount(msg.region);
          reply({ type: 'ok', seq: msg.seq, regions: runtime.regions });
          break;
        case 'route': {
          const route = await runtime.route(msg.request);
          reply({ type: 'ok', seq: msg.seq, route });
          break;
        }
        case 'regions':
          reply({ type: 'ok', seq: msg.seq, regions: runtime.regions });
          break;
        case 'dispose':
          runtime.dispose();
          reply({ type: 'ok', seq: msg.seq, regions: [] });
          break;
      }
    } catch (err) {
      reply({
        type: 'error',
        seq: msg.seq,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof RoutingError ? { detail: err.detail, status: err.status } : {}),
      });
    }
  })();
};
