# Canopy Nav — Status

Android app recreating the Android Auto / Google Maps navigation UI with
offline OSM routing. **Capacitor + React 19 + TypeScript**.

Public repo: https://github.com/IamCoder18/canopy-nav

## Current state

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` (vitest) | **47/47** |
| `npm run e2e` (real browser, built bundle) | **13/13** |
| CI | typecheck → unit tests → build → E2E → APK on tags |
| Latest release | v0.5.0, APK attached automatically |

### Verified end to end in a real browser

Import `.osm` → offline gazetteer search → compute offline route → preview →
navigate (ETA bar, maneuver banner, route line, location puck) → steps list →
regions screen. No uncaught page errors. Screenshots written per step to
`e2e-screenshots/` and uploaded as CI artifacts.

This is the only test that exercises the worker, region store, router and React
screens *together*; unit tests cannot catch a wiring regression between them.

## Bugs found and fixed

Every one of these was invisible until something forced it into the open.

**Unitless `line-height` blanking text.** Design tokens declared
`lineHeight: 32`. React treats `lineHeight` as a unitless property and
serialises it without a unit, so it reached CSS as a *multiplier* — a 768px line
box on a 24px font. Inside `.quick-tile` (fixed height, `overflow: hidden`) the
label box collapsed to a healthy-looking 38px while the glyphs were drawn at the
centre of the 768px box, ~308px below it and clipped away. `elementFromPoint`
kept reporting a normal-looking box, which is why this read as a paint bug for
so long. Systemic: brand title, subtitle, hint card and `.text-btn` were all
blank too. Fixed by serialising px, plus a `TypeToken` type that pins
`lineHeight` to `${number}px` so a bare number is now a compile error.

**Invisible navigation icons.** Every icon defaulted to `color='#fff'` while the
nav control stack renders on white circular buttons — four white-on-white empty
circles. Icons now default to `currentColor`, which removes the bug class rather
than patching four call sites.

**Off-route distance measured in degrees.** `snapToPolyline` compared projected
offsets with `Math.hypot` over raw degrees. A degree of longitude is ~cos(lat)
smaller than a degree of latitude, so 55 m east-west read as ~22 m at Calgary's
latitude and was ignored — breaking detection in the direction it most needed to
work. Now measured with haversine.

**Spatial index cache collision.** `routeOnGraph` cached one spatial index
globally, keyed on node *count*. Two extracts with equal node counts — routine
once several provinces are loaded — routed against the other's buckets. Now a
`WeakMap` keyed on graph identity, with a regression test.

**Release CI SDK setup.** `setup-android` installs the legacy `tools` package,
which no longer exists, so every release job died before Gradle started.

**Inverted one-way direction flags.** Flags mean "this direction is *permitted*",
but the edge builder tested `!(flags & FLAG_ONEWAY_B)`. For a normal two-way road
that is false, so **no edge was ever added** — a 24-edge graph instead of 288,
and every route returned `null`. This was the highest-impact bug in the project
and the fixture is what exposed it.

**Occluded first list row.** `.search-results` / `.settings-body` had
`padding-top: 0` under an absolutely-positioned app bar, so the first row of
every list screen sat at y=0 permanently hidden.

**Bidirectional A\* → unidirectional.** The search found the right optimum but
reconstruction returned a 3-point path with a 0.042° teleport; the `h/2`
termination fired early and the halves were stitched without verifying they
connect. Switched to unidirectional A\*, verified against a Dijkstra reference.

## Architecture decisions

**Capacitor over Expo.** MapLibre needs WebGL and the parser needs a Web Worker.
Expo would mean sacrificing one. Bonus: the web build is directly testable in a
browser, so iteration never needs an emulator.

**On-device routing is TypeScript, not Valhalla.** Valhalla ships no Android
binary or SDK; cross-compiling needs the NDK plus protobuf, boost, luajit,
prime_server, sqlite3 and GEOS for arm64. The default engine is a self-contained
A\* over a graph parsed from `.osm`. Valhalla remains a selectable provider
(FOSSGIS, Simplerouting.io, custom endpoint).

**Regions merge by OSM node ID.** Geofabrik cuts boundaries through node
topology, so a border road carries the *same* node IDs in both extracts.
Union-find collapses the boundary and the seam disappears — versus stitching two
routes at a boundary point, which leaves a visible jump.

**Degrade, never fail.** Online providers fall back to the local engine; traffic
failures return `null` rather than erroring; location falls back
device → browser → simulated, and the active mode is always shown in the status
pill.

## Still to do

- **Never run on a physical device.** Everything here is browser-verified. This
  is the biggest remaining risk — WebView rendering, GPS behaviour, file
  picking and performance on a phone are all unverified.
- **Real region download.** The catalogue shows `.osm.pbf` URLs and sizes, but
  nothing fetches bytes. Import is a file picker that stores `.osm` XML under a
  catalogue id. A real flow needs fetch → Capacitor Filesystem write → re-read,
  plus a protobuf reader in `engine.worker.ts` for `.pbf`.
- **No persistence.** Regions live for the session and die with the process.
- **Cross-region search unused.** `searchAll()` exists and is tested but has no
  UI, so a second region's gazetteer isn't searchable yet.
- **Offline vector tiles not bundled**, so offline map is sparse when zoomed out.
- **Offline turn-by-turn** infers turns from bearing changes; real instructions
  need Valhalla.
- **Optional: NDK cross-compile Valhalla** to replace the local engine.

## Commands

```bash
npm test                  # 47 unit tests
npm run e2e               # 13 browser checks against the built bundle
npm run build             # typecheck + production build
npm run apk               # sync + gradlew assembleDebug (needs JDK 21, NOT 25)
npm run dev               # dev server
```

Gradle 8.11 cannot run on Java 25 (`Unsupported class file major version 69`).
Use JDK 21:

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew assembleDebug
```

`npm run apk` defaults `JAVA_HOME` to JDK 21 for this reason.
