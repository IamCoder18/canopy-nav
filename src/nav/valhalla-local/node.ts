/**
 * Node loader for the engine module.
 *
 * `valhalla-wasm` ships `valhalla.js` as UMD inside an ESM package
 * (`"type": "module"`), so neither `import` nor `require` yields its factory:
 * as ESM the `var ValhallaModule` is module-scoped and the UMD tail sees no
 * `exports`. It is evaluated here the way a classic script would run, which is
 * also exactly what the worker does with `importScripts`.
 *
 * The async wrapper is not decoration: Node 26's module-syntax detection
 * rejects a bare eval of the source (its embedded `require("ws")` branches plus
 * await look ambiguous to it). Wrapping the source in an async function and
 * *passing* `require` in as a parameter resolves both.
 *
 * Host for this loader is Node only (the test suite, tooling). The app loads
 * the module in the worker — see `worker.ts`.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ValhallaModuleFactory } from './runtime';

export async function loadNodeFactory(): Promise<ValhallaModuleFactory> {
  const require = createRequire(import.meta.url);
  const jsPath = require.resolve('valhalla-wasm/valhalla.js');
  const dir = dirname(jsPath);
  const src = readFileSync(jsPath, 'utf8');
  const factory = (await new Function(
    'require',
    '__filename',
    '__dirname',
    `return (async () => { ${src}\n;return ValhallaModule; })();`,
  )(require, jsPath, dir)) as ValhallaModuleFactory;
  // Locate `valhalla.wasm` beside the script rather than trusting the build's
  // own resolution, which assumes a classic-script host.
  return (opts) => factory({ locateFile: (p) => join(dir, p), ...(opts ?? {}) });
}
