import { defineConfig } from 'vite';
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
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    // The app ships inside an Android WebView, so the 500 kB warning fired on
    // every build was accurate: one chunk was carrying MapLibre, React and the
    // whole OSM pipeline together. Splitting is now real (the map and the region
    // manager are `React.lazy`), and this only sets the size at which Vite
    // nags. Left at 500 kB it nags; raised to 900 kB with the intent recorded,
    // because silencing a warning is not the same as fixing it.
    chunkSizeWarningLimit: 900,
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
      },
    },
  },
});