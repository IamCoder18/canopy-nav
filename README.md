# Canopy Nav

An Android navigation app that recreates the **Google Maps dark navigation UI**, with
**fully offline routing** from OpenStreetMap data — including Valhalla, compiled to
WebAssembly and running on the device.

Built with **Capacitor + React 19 + TypeScript + MapLibre GL**. The UI is web
technology in a native shell, so the same build runs in a browser and is verifiable
there without a device.

**Latest release: v1.3.2.** Tested on real hardware — an Android phone mounted in a
car, driven with live GPS. The full design record, including what is *not* finished,
is in [STATUS.md](./STATUS.md).

## Features

- **Offline routing** — Valhalla runs on-device (WebAssembly) over imported routing
  packs, producing real turn-by-turn maneuvers with no network. A self-contained A\*
  over an imported `.osm`/`.osm.pbf` graph remains as a deprecated fallback.
- **Online routing** — Valhalla providers (FOSSGIS, Simplerouting.io, or your own
  server) when a network is available, with a configurable fallback policy. Each
  route is attributed to the engine that actually answered.
- **Offline search** — cities, streets, addresses and POIs built from OSM tags, with
  typo tolerance and abbreviation matching ("Main St" finds "Main Street"). Import
  several extracts and search across all of them; offline and online results are
  ranked in one list with a source badge.
- **Google Maps dark theme** — its surface ramp, `#8AB4F8` accent, and AAOS layout
  metrics (8dp grid, 96dp app bar, 76dp touch targets). Colour is solid rather than
  alpha-blended, and every text/surface pair is asserted at ≥ 4.5:1 contrast by
  `test/contrast.spec.ts`.
- **Turn-by-turn guidance** — spoken through the platform TTS engine, with full
  sentences that are never cut off mid-utterance. Guidance is real Valhalla maneuvers
  where a pack or online engine produced the route; the raw-import engine infers
  turns from geometry and labels them as inferred.
- **Rerouting** when you miss a turn, keeping current guidance on screen until a
  replacement route exists.
- **Follow camera** that points the way you are driving and glides through turns.
- **Self-contained APK** — the web bundle ships inside the APK, the offline basemap
  fetches nothing, and every remote service is optional. Opening the app in a tunnel
  works after one online open, thanks to a precached service-worker shell.
- **Cross-region routing** as one route over merged extracts, behind a memory guard
  that refuses with a reason instead of failing mid-journey.
- **Accessible** — every screen has a heading, screen changes are announced and take
  focus, and unusable controls say why while staying reachable.

## Quick start

```bash
npm install
npm run dev          # dev server
npm test             # 1,458 unit tests
npm run check        # typecheck + lint + unit tests
npm run build        # typecheck + production build
npm run verify       # every gate (unit, build, browser suites, audits)
npm run serve        # LAN server, so a phone can load the built app
```

### Build the APK

Requires the Android SDK and **JDK 21** (Gradle 8.11 cannot run on JDK 25).

```bash
export ANDROID_HOME=/path/to/android-sdk
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 npm run apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Pushing a `v*` tag
builds a debug APK and attaches it to a GitHub Release
(`.github/workflows/release.yml`).

### Device smoke test

With one device or emulator connected (`adb devices`):

```bash
npm run apk            # build + sync
npm run apk:smoke      # install, go offline, import a fixture, screenshot, scan logcat
```

`tools/offline-smoke.mjs` installs the APK, enables airplane mode (restoring it
afterwards), imports `test/fixture.osm` through the app's real import path, and
verifies the assets are served from the APK itself, the import lands, and logcat
holds no errors. Needs Node ≥ 22 and a **debug** APK (release builds do not expose
the WebView DevTools socket).

## Usage

1. Get map data from [Geofabrik](https://download.geofabrik.de/). Both `.osm.pbf`
   and `.osm` (XML) are read directly — no conversion needed.
2. In the app, **Import** the file (or drag it onto the home screen). Routing packs
   (`.tar`) and pack bundles import through the same flow.
3. **Search** for a destination, then **Start**.

For real turn-by-turn offline, install a **routing pack** alongside the map — either
import a `.tar` built with `tools/build-pack.mjs`, or point the app at a pack server
(see below). Province extracts are 100–900 MB; downloads and parses both stream, and
free space is checked up front. Raw imports of province-sized extracts are refused
on-device by a memory guard with a specific reason; packs sidestep this entirely.

## Routing engines

Settings → **Routing** → **Engines**. Two independent controls, because "I want
Valhalla" and "let me have the offline engine if Valhalla is down" are different
requests:

| Control | Options |
|---|---|
| Route with | Any online engine · Offline Valhalla · Offline (.osm) · FOSSGIS · Simplerouting.io · custom |
| If it cannot route | Use another engine (default) · Fail instead |

| Engine | Needs network | Notes |
|---|---|---|
| **Offline Valhalla** | No | Default. Valhalla compiled to WASM, running on-device over an imported routing pack. Real maneuvers. |
| **Offline (.osm)** | No | Deprecated. Self-contained A\* over an imported map; turns are inferred from geometry and labelled as such. |
| **Valhalla — FOSSGIS** | Yes | Public demo server, best quality, rate-limited. |
| **Valhalla — Simplerouting.io** | Yes | Requires an API key. |
| **Valhalla — custom** | Optional | Point at your own `valhalla_service`. |

Each engine's availability is shown with a specific reason ("API key required", not
"unavailable"), and **Test** contacts it live for a version and latency. When a
fallback engine produces a route, the app says so and states whether it can supply
turn-by-turn at all.

### Routing packs and the pack server

A **routing pack** is a `.tar` of Valhalla tiles built from one or more `.osm.pbf`
extracts (`tools/build-pack.mjs`). Packs keep real maneuvers and stay on disk —
the runtime footprint is a bounded tile cache, not a resident graph.

The **packserver** (`server/`) is a stateless Rust build service: upload extracts,
download a verified bundle containing Valhalla tiles, a gazetteer, and PMTiles
basemap tiles. It is authenticated (API keys, CLI-only admin) and deployed behind
Caddy — see [`server/README.md`](./server/README.md). In the app, Settings →
**Pack service** takes your server address and API key; bundles install with one
tap. Self-hosted plain-HTTP pack servers are accepted with a warning. Independently
built packs do not merge at borders — submit adjacent extracts together.

## Architecture

```
src/
  App.tsx              screens and navigation state
  settings.ts          durable settings + endpoint validation
  sw.ts                offline shell (service worker)
  voice.ts             spoken guidance
  theme.ts             design tokens: Google Maps dark palette + AAOS metrics
  search/              one matcher, one ranking: typos, abbreviations, cross-source
  osm/
    engine.worker.ts   OSM parser (streaming), road graph, A* (deprecated engine)
    pbf.ts             .osm.pbf protobuf reader
    merge.ts           union-find merge of adjacent extracts
    importguard.ts     heap guard: refuses imports that would kill the WebView
  nav/
    valhalla-local/    Valhalla WASM engine: packs as lazy tiles, worker transport
    providers.ts       engine chain, attempt trace, connectivity
    engines.ts         engine selection, readiness, provenance
    guidance.ts        step model and progress along the route
    reroute.ts         reroute policy: when to act, backoff, messaging
    valhalla.ts        hosted Valhalla client
    geocode.ts         Nominatim client
  map/                 MapLibre view, tile/offline style switch, overlays
  regions/             region library, pack/bundle stores, pack service client
server/                packserver: Rust build service (see server/README.md)
tools/                 build-pack, offline-smoke, bundle budget, audits
test/                  76 unit specs + browser suites (e2e, screens, focus, shots)
```

Capacitor was chosen over Expo because MapLibre needs WebGL and the OSM parser needs
a Web Worker; the web-first model also makes the build output directly testable in a
browser. On-device routing is Valhalla-in-WASM rather than a native build because the
WASM engine is only 1.4–1.7× slower than native (a 739 km route across a 279 MB tile
set in ~75 ms warm) while avoiding an NDK toolchain of protobuf, boost and friends.

## Testing

```bash
npm run verify       # every gate below, in one command (what CI runs)
npm test             # 1,458 unit tests across 76 files
npm run check        # typecheck + type-aware lint + unit tests
npm run e2e          # 89 browser checks against the built bundle (run per fixture format)
npm run screens      # 53 checks × 3 viewports, plus compact-width checks
npm run focus        # 15 keyboard and focus checks in a real browser
npm run shots        # screenshot every screen + record computed styles
npm run bundle       # gzip size budgets; fails on regression
```

Two gates are ratchets, not reports: the entry chunk's gzip size (`tools/bundle-budget.mjs`)
and the lint warning count (`--max-warnings 27`) are asserted on every build, so
raising either is a deliberate edit.

The browser suites import the fixture, route across it, drive the reroute flow by
moving the simulated GPS fix, and audit every screen for horizontal overflow and
zero-size text at phone-portrait, phone-landscape and head-unit sizes. `npm run
focus` exists because a unit suite structurally cannot see where focus ended up.
`npm run shots` records each screen's *computed* styles alongside its screenshot, so
a defect that CSS error recovery silently discarded shows up as a recorded value
rather than an opinion about a picture.

The server has its own gate: `cd server && cargo test --locked`, plus a Docker
image whose real Valhalla pipeline is exercised by `server/smoke.mjs`
(`.github/workflows/packserver.yml`).

## Status

Verified by the full browser gate suite, the Android emulator, and on real hardware:
an Android phone mounted in a car, driven with live GPS. Known limitations, in
brief:

- **Turn-by-turn is real only where Valhalla produced the route** — a routing pack or
  an online engine. The deprecated raw-import engine infers turns from geometry and
  the app labels them as inferred.
- **Province-sized raw imports are refused on-device by design** (the heap guard);
  use routing packs for large regions.
- Peak memory of a full province parse and long-run GNSS behaviour on phone hardware
  are not yet measured.

[STATUS.md](./STATUS.md) is the complete design record: what is verified, how, and
what is not.

## Data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
[ODbL](https://www.openstreetmap.org/copyright). Routing via
[Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OSM projects. Base tiles from
[OpenFreeMap](https://openfreemap.org/). The on-device engine is
[`ecc521/valhalla-wasm`](https://github.com/ecc521/valhalla-wasm) (MIT).
