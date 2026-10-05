# Canopy Nav

An Android app that recreates the **Android Auto / Google Maps** navigation UI,
with **fully offline routing** from OpenStreetMap data.

Built with **Capacitor + React 19 + TypeScript**. The entire UI is web
technology wrapped in a native shell, so the same codebase runs in a browser —
which is why most of it is verified in Chromium rather than on a device.

Latest release: **v0.11.3**. See [STATUS.md](./STATUS.md) for the full design
record, including what is *not* finished.

---

## What it does

- **Recreates the Android Auto UI** using the official AAOS design system:
  grayscale palette, elevation ramp, 8dp grid, type scale, and component metrics
  (96dp app bar, 76dp touch targets, 158dp grid cells).
- **Offline routing** from an imported `.osm` file. No network required.
- **Online routing** via Valhalla when a network is available, with the engine
  and fallback policy under your control.
- **Offline search** — cities, streets, addresses and POIs, built from OSM tags.
  Import several extracts and search across all of them.
- **Reroutes when you miss a turn**, keeping the existing guidance on screen
  until a replacement route exists.
- **Streams large extracts**, so a province is parsed in a bounded window rather
  than held in memory twice.
- **Speaks the guidance** through the platform's own text-to-speech engine, once
  per step rather than on every position update.
- **Starts with no network at all.** A service worker precaches the app shell, so
  opening the app in a tunnel works once it has been opened online once.

## Quick start

```bash
npm install
npm run dev          # dev server
npm test             # 702 unit tests
npm run build        # typecheck + production build
npm run serve        # LAN server, so a phone can load the built app
```

### Build the APK

Requires the Android SDK and **JDK 21** (Gradle 8.11 cannot run on JDK 25).

```bash
export ANDROID_HOME=/path/to/android-sdk
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 npm run apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

## Usage

1. Get an extract from [Geofabrik](https://download.geofabrik.de/). Both
   `.osm.pbf` and `.osm` (XML) are read directly — no conversion needed:
   ```bash
   # or convert, if you prefer XML
   osmium cat region.osm.pbf -o region.osm
   ```
2. In the app: **Import .osm** → choose the file. You can also drag an extract
   onto the home screen.
3. **Search** for a destination, then **Start**.

Province extracts are 100–900 MB. The download streams, the parse streams, and
the app checks free space before starting rather than failing at 80%.

## Choosing a routing engine

Settings → **Routing** → **Engines**. Two independent controls, because "I want
Valhalla" and "let me have the offline engine if Valhalla is down" are different
requests:

| Control | Options |
|---|---|
| Route with | Any online engine · Offline (.osm) · FOSSGIS · Simplerouting.io · custom |
| If it cannot route | Use another engine (default) · Fail instead |

| Engine | Needs network | Notes |
|---|---|---|
| **Offline (.osm)** | No | Default. Self-contained A\* over the imported graph. |
| **Valhalla — FOSSGIS** | Yes | Public demo server, best quality, rate-limited. |
| **Valhalla — Simplerouting.io** | Yes | Requires an API key. |
| **Valhalla — custom** | Optional | Point at your own `valhalla_service`. |

Each engine's availability is shown with a specific reason — "API key required",
not "unavailable" — and **Test** contacts it live for a version and latency.

**The route is attributed to whichever engine actually answered.** If a fallback
engine produced it, the app says so and states whether that engine can supply
turn-by-turn at all, because the offline engine cannot. That distinction is
recorded per request in the Engines screen.

## Architecture

```
src/
  ErrorBoundary.tsx  crash screen; reports rather than swallows
  settings.ts        durable settings + endpoint validation
  sw.ts              offline shell (service worker), built as its own entry
  voice.ts           spoken guidance, or an honest "unavailable"
  osm/
    engine.worker.ts   OSM parser (whole + streaming), road graph, A*, gazetteer
    pbf.ts             .osm.pbf protobuf reader
    merge.ts           union-find merge of adjacent extracts  [not wired in]
    regions.ts         multi-region library + download catalogue
  nav/
    providers.ts       engine chain, attempt trace, connectivity
    engines.ts         engine selection, readiness, provenance
    offroute.ts        off-route detection primitives
    reroute.ts         reroute policy: when to act, backoff, messaging
    valhalla.ts        Valhalla /route client
    geocode.ts         Nominatim client (1 req/s throttle)
    maneuver.ts        Valhalla maneuver codes -> icons
  map/
    MapView.tsx        MapLibre view, tile/offline style switch
    style.ts           Google palette, tile remap, offline LOD
  regions/
    RegionsScreen.tsx  manage, catalogue, cross-region preview
    download.ts        streaming downloader with resume
    persist.ts         IndexedDB caching of parsed datasets
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
substantial undertaking whose feasibility is not established. So the default
engine is a self-contained A\* over a graph parsed from `.osm`. Valhalla remains
available as an engine.

### Cross-region routing is not merged — and that is a known gap

`osm/merge.ts` implements merging correctly (union-find over shared OSM node
IDs, with direction permissions reconciled) and is well tested, but **the app does
not call it**. Routing across two downloaded regions instead stitches two
separately-routed legs at a point derived from their *bounding boxes*, which
produces a continuous-looking line that is not the route a driver would take.

This was previously recorded as done and is now documented as the top open gap.
`STATUS.md` §3.5.2 has the analysis, and §7 gap 1 has the decision.

## Testing

```bash
npm run check        # typecheck + lint + unit tests
npm test             # 702 unit tests
npm run lint         # type-aware ESLint, ratcheted at 27 warnings
npm run bundle       # gzip size budget on the built output; fails on regression
npm run e2e          # 39 browser checks against the built bundle
npm run screens      # 150 screen checks across 3 viewports
npm run serve        # then point the browser suites at it
```

`npm run bundle` is a ratchet, not a report: the entry chunk is parsed on a
phone's main thread before anything is interactive, so its size is asserted on
every build rather than noted in a document nobody re-reads. Raising a budget is
a deliberate edit to `tools/bundle-budget.mjs`.

The browser suites import the fixture, route across it, drive the reroute flow by
moving the simulated GPS fix, and audit every screen for horizontal overflow and
zero-size text at phone-portrait, phone-landscape and head-unit sizes.

CI runs all of it and uploads screenshots as artifacts. Pushing a `v*` tag also
builds a debug APK and attaches it to a GitHub Release — see
`.github/workflows/release.yml`.

## Status and honesty

[STATUS.md](./STATUS.md) is the design record: what is verified, how, and what
is not.

Three things worth knowing before relying on this:

- **Cross-region routing is wrong** (§7 gap 1). Single-region routing is
  unaffected and is the common case.
- **Offline turn-by-turn guidance is inferred, not real.** The offline engine
  cannot produce instructions, so turns are guessed from where the road bends.
  Measured against Valhalla it missed three of seven real maneuvers on one 4 km
  stretch. The app labels inferred guidance as inferred; choose a Valhalla engine
  for real turn-by-turn.
- **It has never run on physical hardware.** Everything is browser-verified plus
  one Android 14 emulator. WebView behaviour, real GPS quality and on-phone
  memory pressure are unproven.

## Data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[ODbL](https://www.openstreetmap.org/copyright). Routing via
[Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OSM projects. Base tiles from
[OpenFreeMap](https://openfreemap.org/).