// `vitest/config` rather than `vite`: it re-exports Vite's `defineConfig` widened
// with the `test` key. Importing from `vite` makes `test` a type error, which is
// the documented way to end up with a test config TypeScript does not check.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Build identity, injected into the service worker.
 *
 * It keys the offline shell's cache name. Without it the cache would never be
 * invalidated, and a worker would keep serving the previous release's
 * content-hashed assets indefinitely — the standard way an offline shell rots.
 * Read from package.json rather than hard-coded so bumping the version is enough.
 */
const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string;

export default defineConfig({
  plugins: [
    react(),
    /**
     * Emit the full asset manifest so the service worker can precache it.
     *
     * The worker could only precache what `index.html` names — the entry chunk
     * and its CSS. The map and region-manager chunks are dynamically imported,
     * so nothing referenced them, and an offline cold start then failed to load
     * the map's stylesheet. A service worker installed during its first load does
     * not control that load either, so the lazy chunks were never cached by
     * observation.
     *
     * The list is generated from the bundle itself rather than a hand-kept file,
     * so it cannot drift.
     */
    {
      name: 'canopy-precache-manifest',
      generateBundle(_options, bundle) {
        const files = Object.keys(bundle).map((name) => `./${name}`);
        // Files in `public/` are copied verbatim and never appear in the bundle,
        // so they have to be read from disk. Without this the favicon and the web
        // app manifest were the assets that still failed offline.
        for (const f of readdirSync(new URL('./public', import.meta.url))) {
          files.push(`./${f}`);
        }
        this.emitFile({
          type: 'asset',
          fileName: 'precache-manifest.json',
          // The worker itself must not be in the list: browsers refuse to serve a
          // service worker from a cache, and including it only invites confusion.
          source: JSON.stringify(files.filter((p) => !p.endsWith('/sw.js')), null, 2),
        });
      },
    },
  ],
  define: {
    __CANOPY_BUILD__: JSON.stringify(version),
  },
  server: { host: true, port: 5173 },
  /**
   * Test runner configuration.
   *
   * `--expose-gc` exists for one assertion. `test/streamscale.spec.ts` measures
   * how much heap the streaming XML parse retains, and without a way to collect
   * garbage first that measurement is mostly noise: the same 6.3 MB document
   * measured 1.46x on one run and 4.98x on the next, purely on what the collector
   * happened to do. A memory gate that varies fourfold between runs is worse
   * than no gate, because it trains people to re-run until it goes green.
   *
   * `pool: 'forks'` is what makes `execArgv` reachable. It is the one setting
   * here that is not free, so it is recorded with its reason: the whole suite
   * passes under it, and if that ever stops being true the memory measurement is
   * the thing to drop, not the flag.
   */
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--expose-gc'] },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    // The 500 kB warning once fired on every build and was accurate: one chunk
    // carried MapLibre, React and the whole OSM pipeline together. That is now
    // fixed rather than silenced — the screens are their own lazy chunks and
    // MapLibre is split into a vendor chunk below — and this number is what is
    // left: the measured vendor floor (1,053 kB for maplibre-gl 5.24) plus room
    // for the library to grow across updates, so the nag that remains says
    // "the vendor moved", which is worth knowing. See `manualChunks` and
    // `tools/bundle-budget.mjs`.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // The offline shell is a second entry rather than something reached via
        // `new URL('./sw.ts', import.meta.url)`. That form makes Vite treat the
        // worker as a *static asset*, and it emitted `sw-<hash>.ts` — the
        // untranspiled TypeScript source, which a browser cannot execute. A
        // service worker has to be compiled and land at a stable, unhashed path,
        // because that path is the URL the registration names.
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          // Stable, unhashed: the browser compares the registered URL byte for
          // byte. The cache name carries the version instead.
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        /**
         * MapLibre gets a chunk of its own.
         *
         * It is `dist/maplibre-gl.js` — a UMD bundle, the package's `main`, with
         * no ESM build shipped and therefore nothing for Rollup to shake: all
         * 1,032 kB of it arrive whether or not the app uses Marker, Popup or the
         * fullscreen control. Bundled with app code (which is what this chunk
         * used to be), every app change also invalidated a megabyte of vendor
         * JavaScript in every driver's cache. Split out, the app chunks are
         * small and re-download on app changes; the vendor chunk changes only
         * when the library does.
         *
         * `chunkSizeWarningLimit` above is sized to this chunk and nothing
         * else: the measured floor plus room for the library's own growth, not
         * a target. The budget that fails builds is `tools/bundle-budget.mjs`,
         * which measures every chunk in gzip, per role — because that is what
         * crosses the wire, and because a raw-size number shared by a 1 MB
         * vendor and a 40 kB screen is a number that cannot mean both.
         */
        manualChunks: {
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
});