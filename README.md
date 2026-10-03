# Canopy Nav

An Android app that recreates the **Android Auto / Google Maps** navigation UI,
with **fully offline routing** from OpenStreetMap data.

Built with **Capacitor + React 19 + TypeScript**. The entire UI is web
technology wrapped in a native shell, so the same codebase runs in a browser.

---

## What it does

- **Recreates the Android Auto UI** using the official AAOS design system:
  pixel-verified grayscale palette, elevation ramp, 8dp grid, type scale, and
  component metrics (96dp app bar, 76dp touch targets, 158dp grid cells).
- **Offline routing** from an imported `.osm` file. No network required.
- **Online routing** via Valhalla when a network is available.
- **Offline search** — cities, streets, addresses and POIs, built from OSM tags.
- **Multi-region** — download or import several provinces/states and route
  *between* them; adjacent extracts merge seamlessly.
- **Degrades gracefully** — lose signal mid-trip and guidance continues; only
  traffic and rerouting become unavailable.

## Quick start

```bash
npm install
npm run dev          # dev server
npm test             # 31 tests
npm run build        # typecheck + production build
```

### Build the APK

Requires the Android SDK and **JDK 21** (Gradle 8.11 cannot run on JDK 25).

```bash
export ANDROID_HOME=/path/to/android-sdk
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 npm run apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

## Usage

1. Get an extract from [Geofabrik](https://download.geofabrik.de/), or convert
   a `.pbf` first:
   ```bash
   osmium cat region.osm.pbf -o region.osm
   ```
2. In the app: **Import .osm** → choose the file.
3. **Search** for a destination, then **Start**.

## Routing providers

Selectable in Settings:

| Provider | Needs network | Notes |
|---|---|---|
| **Offline (.osm)** | No | Default. Self-contained A\* over the imported graph. |
| **Valhalla — FOSSGIS** | Yes | Public demo server, best quality, rate-limited. |
| **Valhalla — Simplerouting.io** | Yes | Requires an API key. |
| **Valhalla — custom** | Optional | Point at your own `valhalla_service`. |

Online providers fall back to the local engine, so a route never fails outright
because the network dropped.

## Architecture

```
src/
  osm/
    engine.worker.ts   OSM parser, road graph, A*, gazetteer  (Web Worker)
    merge.ts           union-find merge of adjacent extracts
    regions.ts         multi-region library + download catalogue
  nav/
    valhalla.ts        Valhalla /route client
    geocode.ts         Nominatim client (1 req/s throttle)
    providers.ts       provider chain, fallback, connectivity
    maneuver.ts        Valhalla maneuver codes -> icons
  map/
    MapView.tsx        MapLibre view, tile/offline style switch
    style.ts           Google Maps-style cartography palette
  theme.ts             AAOS design tokens (verified against Google's specs)
  App.tsx              screens and navigation state
```

### Why not Expo?

MapLibre needs WebGL and the OSM parser needs a Web Worker. Expo would mean
sacrificing one or the other. Capacitor's web-first model also means the build
output is directly testable in a browser.

### Why is on-device routing TypeScript rather than Valhalla?

Valhalla ships no Android binary or SDK. Cross-compiling requires the NDK plus
protobuf, boost, luajit, prime_server, sqlite3 and GEOS all built for arm64 — a
substantial undertaking. So the default engine is a self-contained A\* over a
graph parsed from `.osm`. Valhalla remains available as a provider.

### How regions merge

Geofabrik cuts province boundaries through OSM node topology, so a road crossing
the Alberta/BC border carries the **same node IDs** in both extracts. Merging is
therefore union-find over node IDs: the boundary collapses and routing flows
across it as ordinary continuous road, with no seam.

## Testing

```bash
npm test
```

31 tests covering OSM parsing, graph construction, one-way handling, route
optimality (against a Dijkstra reference), geometry continuity, region merging,
the offline gazetteer, and geo formatting.

## CI

Pushing a `v*` tag builds a debug APK and attaches it to a GitHub Release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

See `.github/workflows/release.yml`.

## Status

See [STATUS.md](./STATUS.md) for what is verified, what is incomplete, and known
issues. **GPS is currently simulated** and the app has not yet been run on a
physical device.

## Data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[ODbL](https://www.openstreetmap.org/copyright). Routing via
[Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OSM projects.
