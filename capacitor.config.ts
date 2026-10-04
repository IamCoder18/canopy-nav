import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.canopy.nav',
  appName: 'Canopy Nav',
  webDir: 'dist',
  android: {
    // Landscape-locked: this app is a head-unit UI replica.
    backgroundColor: '#0B0B0F',
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
    // Android 15 (SDK 35) draws edge-to-edge by default, which puts the status
    // and navigation bars over the WebView. The WebView then reports no
    // safe-area insets to CSS, so env() stays 0 and the app bar ends up behind
    // the clock. Letting Capacitor apply the system-bar margins means the page
    // is laid out inside them and every fixed element lines up.
    adjustMarginsForEdgeToEdge: 'force',
  },
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    Filesystem: {},
  },
};

export default config;
