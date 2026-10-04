# Canopy Nav — Status

Android app recreating the Android Auto / Google Maps navigation UI with
offline OSM routing. **Capacitor + React 19 + TypeScript**.

Public repo: https://github.com/IamCoder18/canopy-nav

## Current state

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` (vitest) | **345 passing** |
| `npm run e2e` (real browser, built bundle) | **13/13** |
| Screen coverage (3 viewports) | all pass |
| Android emulator (API 34, 2340x1080) | installs, runs, **no console errors** |
| CI | typecheck → unit → build → E2E (both formats) → viewport audit → APK on tags |

### Verified on a real Android device

An Android 14 emulator was booted, the APK installed, and driven with a real
GPS fix. This found two bugs that browser testing structurally could not:

- **Geolocation was broken on device.** `@capacitor/geolocation`'s native object
  is a Proxy; awaiting its return value calls `then()` *on the plugin*, failing
  with `Geolocation.then() is not implemented on android`. Now uses the
  WebView's own `navigator.geolocation` — same platform LocationManager, a real
  Promise, and the path the browser build already exercises. Status pill reads
  "GPS" rather than "Simulated GPS".
- **System bars overlapped the app bar.** Android 15 draws edge-to-edge and the
  WebView reports no safe-area insets, so `env(safe-area-inset-*)` stayed 0.
  The activity is now immersive, which is what Android Auto and Automotive OS
  do for navigation apps anyway.

## Bugs found and fixed

Every one was invisible until something forced it into the open.

**Packed-integer key aliasing, twice.** `merge.ts` packed a node pair as
`a * 2^32 + b` — exact only below 2^21 nodes, with the directed variant giving
out at 2^20. A province extract is well past that, so distinct roads collided and
were dropped: border roads vanished, exactly what a cross-province merge
produces. `engine.worker.ts`'s spatial index had the same class of bug:
`(floor(lon/cell) << 16) ^ floor(lat/cell)` coerces to int32, so cells exactly
131° of longitude apart — 9000 km — shared a bucket, and `nearest()` near the
antimeridian searched the opposite side of the planet. Both replaced with nested
`Map` keys, which cannot overflow.

**Inverted one-way flags.** Flags mean "direction *permitted*", but the edge
builder tested `!(flags & FLAG_ONEWAY_B)`. For a two-way road that is false, so
**no edge was ever added** — 24 edges instead of 288, and every route returned
`null`.

**Unitless `line-height`.** Tokens declared `lineHeight: 32`; React serialises
that without a unit, so it reached CSS as a *multiplier* — a 768px line box on a
24px font. Glyphs drew ~308px below a healthy-looking box and were clipped by
`overflow: hidden`. `elementFromPoint` kept reporting a normal-looking box,
which is why it read as a paint bug for so long. Now pinned by a type that makes
a bare number a compile error.

**Merged graphs turned two-way roads one-way.** Dedup keyed on the *unordered*
node pair, so the reverse record collided with the forward one. Reverse routing
returned `null`.

**Offline fallback crashed on long routes.** `Math.min(...geometry.map(...))`
overflowed the stack past ~125k points — inside the path that exists to save a
trip when signal drops.

**Every online search was malformed.** Nominatim's `viewbox` was built
`[lat, lon]` when the API documents x as longitude — Berlin requested as
lon 53.1, lat 14.

**Valhalla units and geometry.** `summary.length` passed through in km while
consumers expected metres ("Distance 0 m"); the arrival point was duplicated;
every leg after the first was discarded.

**Invisible nav icons.** Icons defaulted to `#fff` on white buttons. Now
`currentColor`.

**Stale APK artefacts.** `npx cap sync` never prunes removed files, so old JS
chunks were packaged and served at runtime — which made a fix look like it had
not landed. `npm run sync` clears the directory first.

## Architecture decisions

**Capacitor over Expo.** MapLibre needs WebGL and the parser needs a Web Worker.
Expo would mean sacrificing one. Bonus: the web build is directly testable.

**On-device routing is TypeScript, not Valhalla.** Valhalla ships no Android
binary or SDK; cross-compiling needs the NDK plus protobuf, boost, luajit,
prime_server, sqlite3 and GEOS for arm64. The default engine is a self-contained
A* over a graph parsed from `.osm` / `.osm.pbf`. Valhalla remains selectable.

**Regions merge by OSM node ID.** Geofabrik cuts boundaries through node
topology, so a border road carries the *same* node IDs in both extracts.
Union-find collapses the boundary and the seam disappears.

**Degrade, never fail.** Online providers fall back to the local engine; traffic
reports confidence honestly (`live` / `estimated` / `none`); location falls back
device → browser → simulated with the active mode always visible.

**No dead controls.** The traffic toggle is disabled with a stated reason unless
a provider produced a real verdict. Satellite layers were omitted rather than
shipping a grey rectangle.

## Still to do

- **Real region download.** A streaming downloader is being added; the UI wiring
  is the remaining step.
- **File import through the Android SAF picker** is browser-tested only; driving
  that picker over adb was not automatable here.
- **No offline vector tiles.** Offline mode draws from `.osm` geometry, so it is
  sparse when zoomed out.
- **Offline turn-by-turn** infers turns from bearing changes; real instructions
  need Valhalla.
- **zstd PBF blobs** are rejected by name rather than decoded. Geofabrik still
  ships zlib, so this is future-proofing only.
- **Antialiasing of emulator cutout.** A black band remains where the emulator
  simulates a display cutout; believed cosmetic and device-specific, not
  confirmed on real hardware.
- Optional: NDK cross-compile of Valhalla to replace the local engine.

## Commands

```bash
npm test                  # 345 unit tests
npm run e2e               # 13 browser checks against the built bundle
npm run build             # typecheck + production build
npm run apk               # sync + gradlew assembleDebug (needs JDK 21, NOT 25)
npm run dev               # dev server
```

Gradle 8.11 cannot run on Java 25 (`Unsupported class file major version 69`).
Use JDK 21; `npm run apk` defaults `JAVA_HOME` to it.

### Android device testing

```bash
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n canopy -k "system-images;android-34;google_apis;x86_64" -d pixel_6
sudo gpasswd -a "$USER" kvm          # /dev/kvm is root:kvm 0660
sg kvm -c "$ANDROID_HOME/emulator/emulator -avd canopy -no-window -no-audio -gpu swiftshader_indirect"
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
adb emu geo fix <lon> <lat>          # feed a real position
adb logcat -d | grep -i "Capacitor/Console"
```

The `geo fix` matters: without it the app reports "Simulated GPS" and the
position-driven route progress cannot be exercised.
