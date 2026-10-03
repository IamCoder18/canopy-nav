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
