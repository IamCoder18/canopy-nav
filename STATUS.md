# Canopy Nav — Status

Android app recreating the Android Auto / Google Maps navigation UI with
offline OSM routing. **Capacitor + React 19 + TypeScript**.

## Final state of this session

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **31/31 passing** |
| `npx vite build` | succeeds |
| `gradlew assembleDebug` | **BUILD SUCCESSFUL** |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk` (4.6 MB) |
| APK manifest | `com.canopy.nav`, minSdk 23, location + internet perms, sensorLandscape |

### Verified working

- **OSM XML parsing** — nodes, ways, tags, entity decoding.
- **Road graph** — 81 nodes / 288 edges / 1 connected component on the fixture.
  Pure-geometry nodes (park, river) stripped from the routing core.
- **One-way handling** — verified in both directions.
- **A\* routing** — returns the same optimum as a Dijkstra reference (860 s),
  contiguous geometry with no teleports. Turned out to be the one real fix that
  mattered: see the bug below.
- **Region merging** — union-find on OSM node IDs; 1 component, geometry intact.
- **Offline gazetteer** — cities, streets, addresses, POIs.
- **Valhalla client** — live-tested against FOSSGIS (Valhalla 3.9.0).
- **Provider fallback** — online Valhalla first, local engine as safety net, so
  losing signal mid-trip degrades instead of failing.
- **Browser verification** — home screen renders, vector tiles load, AAOS
  layout applied.

### The two bugs that actually mattered

**1. Inverted direction flags — routing returned nothing.**
Flags are set when a direction is *permitted*. The edge builder tested
`!(flags & FLAG_ONEWAY_B)`, so for a normal two-way road (flags = 3) that is
`!(2)` = false and **no edge was ever added**. Result: a graph of 24 edges
instead of 288, 73 disconnected nodes, and every route returning `null`. Fixed
by testing the flag positively. This is the single highest-impact bug in the
project and it was invisible until the fixture exposed it.

**2. Bidirectional A\* produced discontinuous paths.**
The search found the correct optimum but reconstruction returned a 3-point
path with a 0.042° gap — a teleport across the map. The `h/2` termination test
was firing early and the head/tail halves were stitched without verifying they
connect. **Switched to unidirectional A\*** at the user's OK. It is verified
against a Dijkstra reference, and the great-circle heuristic is strong enough
on road networks that the speed loss is acceptable. The bidirectional attempt is
documented in the code so it isn't retried blindly.

### Known issue, unresolved

**Quick-tile and hint-card labels don't paint in headless Chromium.** The DOM is
correct — `elementFromPoint` returns the label span with `opacity: 1`, white
color, 24px, positioned inside the tile — but it is absent from the screenshot.
Suspected a Chromium compositing quirk around `backdrop-filter`/stacking
contexts; removing the filter did not resolve it. Almost certainly renders
correctly on a real device and Android WebView, and it does not block any
functionality. **This should be verified on-device before trusting the UI.**

### Not done

- **GPS is simulated.** `usePosition` synthesises movement. Needs
  `@capacitor/geolocation`.
- **Region download UI** — `src/osm/regions.ts` has the full catalogue (all
  Canadian provinces, several US states) and the library, but no screen is
  wired to it.
- **Offline vector tiles** — offline mode draws from `.osm` geometry only, so
  it is sparse when zoomed out.
- **`.osm.pbf`** — XML only; convert on desktop with
  `osmium cat region.osm.pbf -o region.osm`.
- **Offline turn-by-turn** — turns inferred from bearing changes; real
  instructions need Valhalla.
- **Emulator testing** — never attempted; APK is built but not installed/run.

## Architecture decisions

**Capacitor over Expo.** MapLibre needs WebGL and the parser needs a Web
Worker. Expo would mean either dropping the worker or wrapping a WebView anyway.
Bonus: the web build is directly testable in a browser, so iteration never
needs an emulator.

**On-device routing is TypeScript, not Valhalla.** Valhalla ships no Android
binary or SDK — cross-compiling needs the NDK plus protobuf, boost, luajit,
prime_server, sqlite3 and GEOS all built for arm64. Real work, not achievable
in the time available. Valhalla remains a selectable provider with presets.

**Regions merge by OSM node ID.** Geofabrik cuts boundaries through node
topology, so a border road carries the *same* node IDs in both extracts.
Union-find collapses the boundary and the seam disappears — versus stitching
two routes at a boundary point, which leaves a visible jump.

## Commands

```bash
npm test         # vitest — 31/31
npm run build    # tsc --noEmit && vite build
npm run apk      # sync + gradlew assembleDebug (needs JDK 21, NOT 25)
npm run dev      # vite dev server
```

Gradle 8.11 cannot run on Java 25 (`Unsupported class file major version 69`).
Use JDK 21:

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew assembleDebug
```

`npm run apk` defaults `JAVA_HOME` to JDK 21 for this reason.

## Next steps, in priority order

1. **Install the APK on a device and screenshot it.** Confirm the label paint
   issue is a headless artifact, not real. Everything else is unverified
   on-device.
2. Wire `@capacitor/geolocation` to replace simulated GPS.
3. Add the region download/manage screen on top of `regions.ts` — this is the
   "download Alberta / BC and route between them" feature, and the hard part
   (merge) is done and tested.
4. Bundle offline vector tiles for zoomed-out coverage.
5. Optional: NDK cross-compile Valhalla to replace the local engine with
   real turn-by-turn.
