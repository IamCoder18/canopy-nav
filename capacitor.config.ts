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
    // and navigation bars over the WebView.
    //
    // This is 'auto', not 'force', and the reasoning matters. The overlap is
    // solved in MainActivity by going fully immersive -- the bars are hidden and
    // the app owns the display, which is what Android Auto itself does and what
    // a navigation app wants anyway. Forcing Capacitor to apply system-bar
    // margins here would contradict that: it would inset the WebView to make
    // room for bars that MainActivity has just hidden, so the app would be
    // padded by the height of chrome that is not on screen.
    adjustMarginsForEdgeToEdge: 'auto',
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
