import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
  },
});