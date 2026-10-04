# Canopy Nav — Status & Design Record

An Android app that recreates the **Android Auto / Google Maps** navigation UI,
with **fully offline OpenStreetMap routing**.

**Stack:** Capacitor + React 19 + TypeScript + Vite + MapLibre GL
**Repo:** https://github.com/IamCoder18/canopy-nav
**Latest release:** v0.11.1 (unreleased on `main`: engine selection + provenance)

---

## Table of contents

1. [Everything that was asked for](#1-everything-that-was-asked-for)
2. [Verification state](#2-verification-state)
3. [Features: what, how, why](#3-features-what-how-why)
4. [Bugs found and fixed](#4-bugs-found-and-fixed)
5. [Architecture decisions](#5-architecture-decisions)
6. [Project layout](#6-project-layout)
7. [Known gaps](#7-known-gaps)
8. [Commands and workflows](#8-commands-and-workflows)

---

## 1. Everything that was asked for

This is the full list of requests made during the project, and where each one
stands. **Bold** = fully working and verified.

| # | Request | Status | Where |
|---|---|---|---|
| 1 | Android app using Expo **or** Capacitor — agent's choice | **Done.** Capacitor chosen (§5.1) | — |
| 2 | Visually mimic an Android Auto screen as closely as possible | **Done.** AAOS design tokens taken from Google's published specs; "close enough" was later relaxed but the real spec values were kept | `src/theme.ts` |
| 3 | Prefer TypeScript | **Done.** ~9,100 lines TS/TSX. Exactly one hand-written Java file on Android (`MainActivity.java`, immersive mode only) plus XML themes; everything else is TypeScript | `android/` |
| 4 | Other libraries allowed (e.g. Ferrostar) | Considered and rejected — Ferrostar duplicates what the built-in engine does and adds no offline win here | §5.2 |
| 5 | Support `.osm` files | **Done.** XML parser | `src/osm/engine.worker.ts` |
| 6 | Use Valhalla for car navigation | **Done** as an optional provider; **not** the on-device default (§5.3) | `src/nav/valhalla.ts` |
| 7 | Use Nominatim for geocoding start/destination | **Done** as an optional online provider | `src/nav/geocode.ts` |
| 8 | 100% local, no WiFi | **Done.** Offline engine, offline gazetteer, offline map rendering, offline persistence | §3.2–3.4 |
| 9 | Multi-region: download by city/province (Alberta, BC…), route between them | **Done.** 16-entry catalogue, streaming download, seamless merge | §3.5 |
| 10 | Merging the two regions rather than stitching | **Done** — union-find on OSM node IDs (§3.5.2) | `src/osm/merge.ts` |
| 11 | Is self-hosting Valhalla on Android unreasonable? | Answered: not unreasonable, but not achievable in the time available (§5.3) | — |
| 12 | Keep hosted Valhalla as an option | **Done.** 3 presets + custom endpoint, each individually selectable and probeable | §3.6, §3.6.1 |
| 13 | Handle losing connectivity mid-trip | **Done.** Provider chain + snapshotted route + honest degradation | §3.7 |
| 14 | GitHub repo (public) | **Done** | [repo](https://github.com/IamCoder18/canopy-nav) |
| 15 | CI that builds a release with the APK on tags | **Done.** 13 releases, APK attached automatically (v0.1.0 was uploaded by hand) | `.github/workflows/release.yml` |
| 16 | Small increments: one fix/feature per release | **Done.** 15 tags, 13 releases | §8 |
| 17 | Unit tests for everything; subagents for tests and browser verification | **Done.** 418 unit tests across 13 files, plus 2 browser suites | `test/` |
| 18 | Every screen and function verified in real Chromium at mobile size | **Mostly done.** All 9 screens are visited at 3 viewports, 2 of them mobile-sized. Engine selection, per-engine readiness and the post-route provenance trace are covered in `e2e.mjs`. Still not covered: destructive/long-tail flows such as rerouting mid-turn, and the emulator is not a phone | `test/screens.mjs` |
| 19 | Keep going until every issue fixed | Ongoing — see §7 | — |
| 20 | Host on 0.0.0.0 so it can be tested | **Done.** http://192.168.1.83:8080, APK at `/dl/canopy-nav.apk` | — |
| 21 | Update STATUS.md continuously | **This document** | — |

---

## 2. Verification state

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | clean |
| Unit tests | `npm test` | **418 passing**, 13 files |
| End-to-end | `npm run e2e` | **34 checks** against the built bundle |
| Screen coverage | `node test/screens.mjs` | **32 checks × 3 viewports = 96** (phone-portrait 412×915, phone-landscape 892×412, head-unit 1280×720) |
| APK | `npm run apk` | 7.8 MB debug APK, `com.canopy.nav`, minSdk 23, targetSdk 35 |
| Device | Android 14 emulator, API 34, 2340×1080 | installs, runs, **no console errors**, real GPS confirmed |

**Note on the device gate.** The app logs three `Expected value to be of type
number, but found null instead` warnings on launch. These are **pre-existing**,
not new: the v0.11.1 baseline APK was rebuilt and reinstalled and produces the
same three, so the engine work neither introduced nor fixed them. They are not
yet traced to a source.

### Test breakdown

| File | Tests | Covers |
|---|---|---|
| `engine.spec.ts` | 34 | OSM parsing, graph construction, one-ways, A* route quality, geometry continuity, region merging, index isolation and keying |
| `providers.spec.ts` | 46 | provider chain, fallback, `requiresKey`, 4xx handling, `localToRoute` bbox reduction |
| `regions.spec.ts` | 60 | `RegionLibrary`, bbox helpers, `catalogFor`, `searchAll` ranking, `bestFor` |
| `geo.spec.ts` | 54 | polyline codec, haversine, bearing, formatting boundaries, `simplify`, `snapToPolyline` |
| `valhalla.spec.ts` | 36 | request body, headers, response parsing, multi-leg, unit normalisation |
| `download.spec.ts` | 31 | streaming, progress, abort, retry/resume, HTML-error detection, truncation, disk cache |
| `geocode.spec.ts` | 29 | throttle serialisation and 1 req/s spacing, viewbox, place mapping |
| `merge.spec.ts` | 37 | node-ID union, direction permissions, dead-edge sweep, >2^21 node regression |
| `persist.spec.ts` | 21 | typed-array round-trip, quota errors, corrupt records, rehydration |
| `icons.spec.ts` | 4 | every maneuver kind renders distinct geometry |
| `navigation.spec.ts` | 17 | off-route detection, speed-scaled thresholds, traffic verdicts |
| `pbf.spec.ts` | 11 | PBF vs XML parser equivalence on a hand-built file and the whole fixture |
| `engines.spec.ts` | 38 | engine selection policy, plan ordering, per-engine readiness reasons, the attempt trace, strict mode |

---

## 3. Features: what, how, why

### 3.1 Android Auto UI recreation

**What.** An Android Auto / Automotive OS interface: launcher-style home screen,
search, route preview, turn-by-turn navigation with an ETA bar and maneuver
banner, steps list, settings, and an offline-map screen.

**How.** `src/theme.ts` encodes the design system as typed tokens, taken from
Google's published *Design for Driving* documentation:

- **Colour.** The AAOS grayscale palette (`#0E1013`, `#17181B`, `#202124`,
  `#282A2D`, `#3C4043`, `#5F6368`, `#9AA0A6`, `#E8EAED`, `#F1F3F4`) and the
  elevation ramp, night mode: `+1 #0E1013`, `+2 #17181B`, `+3 #202124`. Accent
  `#60A8F0`.
- **Layout.** The 8dp grid; padding scale `P0–P8` = 4/8/12/16/24/32/48/64/96dp;
  keylines `KL0–KL4` per width class; side margins = 12% of app working space.
- **Type.** Full scale — Display 1–3, Body 1–3, Sub 1–3 — following the AAOS rule that
  Roboto is used below 32dp and Google Sans at 32dp and up, with bold avoided in
  favour of Medium.
- **Components.** 76dp minimum touch target, 44/36/24dp icon sizes, 116/128dp
  list rows and `R2`=8dp / `R4`=full corner radii are tokens in `theme.ts`; the
  96dp app bar and 158dp minimum grid cell are the spec's values but are
  currently hardcoded in `styles.css`.

Icons are hand-drawn SVG (`src/icons.tsx`) — 29 maneuver kinds covering
slight/sharp turns, U-turns, ramps, forks, exits, roundabouts, ferries and
arrival, plus system icons.

**Why.** Reading the real spec rather than eyeballing screenshots is what makes
the result defensible, and it means the layout adapts by documented rules
instead of hardcoded magic numbers. Hand-drawn icons avoid shipping Google's
proprietary assets while matching their visual language.

### 3.2 Offline OSM pipeline

**What.** Import an `.osm` (XML) or `.osm.pbf` (protobuf) extract and get a
routable road graph, a searchable gazetteer, and renderable map geometry — with
no network.

**How.** `src/osm/engine.worker.ts` runs in a Web Worker and does four things:

1. **Parse.** Both formats. XML via a streaming regex scanner; PBF via
   `src/osm/pbf.ts`, a protobuf reader handling BlobHeader/Blob framing, zlib
   inflation through `DecompressionStream`, and DenseNodes delta decoding.
   The format is sniffed from the first 16 bytes, not the extension, because both
   arrive through the same file picker.
2. **Build a graph.** Nodes on routable ways become vertices; directed edges
   carry `travel_seconds` and a permission flag pair. Speeds come from a table
   matching Valhalla's `auto` defaults. One-ways, `access` and `maxspeed` are
   honoured.
3. **Compact.** Pure-geometry nodes (park boundaries, watercourses) are stripped,
   leaving only the connected core — otherwise a province reports millions of
   spurious "disconnected components".
4. **Index.** A nested-`Map` spatial hash over cell indices for O(1) nearest-node
   lookup.

Separately it builds a **gazetteer**: place nodes, named POIs, streets, and
`addr:housenumber`/`addr:street` pairs, plus *interpolated* house numbers
placed along each street roughly every 25 m, so "123 Main St" resolves.

**Why.** The Worker keeps tens of seconds of parsing off the UI thread. Sniffing
the format from bytes rather than the extension means a mislabelled file still
works. Compact-then-index keeps memory and component counts honest. House-number
interpolation is what turns "search a place" into "search an address".

### 3.3 Offline routing

**What.** A\* over the parsed graph producing a route, a distance, a duration,
and a per-street step list.

**How.** Unidirectional A\* with three deliberate choices:

- **Costs are travel seconds**, not distance, so the heuristic is a
  straight-line distance divided by an optimistic speed — admissible, so the
  result is optimal.
- **Pass-through nodes carry a 6-second penalty**, which biases the frontier onto
  real junctions and is what makes it fast on dense networks.
- **Flags mean "direction permitted"** and are set, never masked.

On the fixture it returns 860.4 s, asserted against a hand-computed bound for
the grid. There is no separate Dijkstra reference implementation in the repo.

**Why.** Bidirectional A\* was implemented first and rejected. Its search found
the correct optimum but its reconstruction returned a 3-point path with a 0.042°
teleport — the `h/2` termination fired early and the two halves were stitched
without verifying they connect. A valid-but-broken path is far worse than a
slower correct one, so it was replaced. The code and comments record this so it
isn't retried blindly.

### 3.4 Offline search

**What.** Find cities, streets, addresses, POIs and amenities by name.

**How.** An in-memory gazetteer ranked by match quality (exact > prefix >
substring), then category importance, then distance. A category-chip row is
derived from what the downloaded map *actually contains*, so it only offers
questions the data can answer. With more than one region loaded, every gazetteer
is searched and each hit is labelled with its region.

**Why.** Purely in-memory and synchronous, so results appear instantly with no
network. Deriving chips from the data avoids offering a category that would
return nothing. Labelling by region stops a distant hit looking identical to one
underfoot.

### 3.5 Multi-region

#### 3.5.1 Download

**What.** "Download Alberta" — fetch a real Geofabrik extract.

**How.** `src/regions/download.ts`:

- **Streams** with `response.body.getReader()`; chunks are retained and progress
  reported from the byte count. A province `.osm.pbf` is 100–900 MB and
  `arrayBuffer()` on that OOMs a phone.
- **Sniffs the format** from the first 512 bytes (never judging on fewer than
  16) and separates OSM XML from an HTML page. A URL that 404s, sits behind a captive portal or a sign-in wall
  answers with HTML; feeding that to the parser yields a baffling error, so it
  is rejected up front with a message naming the cause.
- **Derives the filename** from the sniffed format, not the URL.
- **Retries** resume with `Range`/`If-Range`, reusing bytes already held.
  Retryable: network drop, truncation, 408/429/5xx. Not retryable: 404, bad
  payloads.
- **Checks free space** up front via `navigator.storage.estimate()` and refuses
  early rather than failing at 80%.
- **Caches** the finished extract through Capacitor Filesystem (native only) so a
  later launch works offline, and clears it when the region is removed.

The Regions screen probes each catalogue URL and greys out dead ones, shows
byte-accurate progress with an explicit "size unknown" when `Content-Length` is
absent, and offers Cancel.

**Why.** Streaming is the only way a phone survives a 900 MB download. Detecting
HTML is the difference between "couldn't reach it" and a parser crash. An absent
content length shows as unknown rather than a fake 0% that reads as stalled.

#### 3.5.2 Merging

**What.** Route *across* Alberta → BC with no seam.

**How.** Union-find over **original OSM node IDs** (`src/osm/merge.ts`). Geofabrik
extracts are cut from the same database, so a border road carries the same node
IDs on both sides. Merging collapses duplicate nodes, remaps edges into a fresh
CSR layout, and unions conflicting direction permissions so a road is never left
impassable.

**Why.** This was explicitly discussed: stitching two routes at a boundary point
leaves a visible jump and a straight-line gap. Because both extracts reference
the same node IDs, merging makes the boundary disappear and routing flows across
as ordinary continuous road.

### 3.6 Online providers

**What.** Valhalla for routing, Nominatim for geocoding, when a network exists.

**How.** `src/nav/providers.ts` defines a chain:

| Provider | Network | Notes |
|---|---|---|
| Offline (.osm) | No | Default. Self-contained A\*. |
| Valhalla — FOSSGIS | Yes | Public demo, live-tested (Valhalla 3.9.0) |
| Valhalla — Simplerouting.io | Yes | Requires an API key; refuses to send without one |
| Valhalla — custom | Optional | Your own `valhalla_service` |

**Why.** See §5.3 for why Valhalla is not the on-device default. Nominatim is
throttled to 1 req/s with a promise chain so concurrent calls serialise and never
overlap, as its usage policy requires.

### 3.6.1 Choosing and seeing engines

**What.** Pick which engine routes, decide whether another may substitute, and
see which one actually answered the last request.

**How.** `src/nav/engines.ts` holds selection and readiness;
`src/nav/providers.ts` keeps only the mechanics of fetching a route. Selection
is two orthogonal controls:

| Control | Values |
|---|---|
| Route with | Any online engine, Offline (.osm), FOSSGIS, Simplerouting.io, custom |
| If it cannot route | Use another engine (default) / Fail instead |

Those are separate because "I want Valhalla" and "let me have the offline engine
if Valhalla is down" are different requests, and one radio group cannot express
both. "Any online engine" expands to every hosted engine in registry order, so
"any" means genuinely any. `planRoute` turns a selection into the ordered plan
`resolveRoute` walks.

Every engine on the plan gets a trace row — including ones never reached, marked
`not tried`. A trace listing only what was attempted cannot answer "why did it
use that engine", which is the only reason to keep one. `degraded` deliberately
keeps its old narrow meaning (only reasons that cost something: no link, no key)
so the banner and its tests are untouched; the trace carries the detail the
banner has no room for.

**Why.** This fixed a real honesty bug rather than only adding a panel. The
status pill named the *selected* engine, so pinning FOSSGIS, letting it fail and
falling back to the offline engine still displayed "Valhalla — FOSSGIS" — a
locally-computed route wearing a hosted provider's name, implying turn-by-turn
the offline engine does not produce. Provenance is now recorded as state at the
moment of the request rather than derived from the selection, precisely because
the two diverge exactly when something failed. Traffic also asks the engine that
served the route rather than the top of the plan, so congestion is never
attributed to a different server than the one that produced the geometry.

Selection policy lives in its own module so it is testable without routing, and
the import direction is one-way (`engines.ts` → `providers.ts`) so the routing
core stays free of selection policy.

### 3.7 Mid-trip connectivity loss

**What.** Signal drops halfway through a drive.

**How.** Three mechanisms:

1. **Provider chain.** Online providers are tried when a network is believed to
   exist; the local engine is always the fallback, so a route never fails
   outright.
2. **Snapshotted route.** Once fetched, geometry, maneuvers, ETA and steps are
   all resolved client-side. Guidance continues with no network at all.
3. **Honest degradation.** Traffic is labelled by its real confidence
   (`live` / `estimated` / `none`); verified traffic data is *kept* when signal
   drops, labelled "last known — no signal to refresh", because blanking true
   information is worse than showing it with a caveat.

**Why.** A navigation app that loses guidance when a tunnel eats the signal is
useless. Degrading to the offline engine costs nothing and saves the trip.

### 3.8 Region persistence

**What.** Don't re-parse a province on every launch.

**How.** `src/regions/persist.ts` stores the *parsed dataset* in IndexedDB, keyed
by region id, in two object stores written in one transaction so a region is
never listed but unloadable. Typed arrays are packed by copying their exact
`ArrayBuffer` bytes (a `subarray` view would otherwise store a much larger
buffer) and validated on load. Corrupt or version-mismatched records are skipped
with a warning rather than taking the library down. Quota failures name the
region, the shortfall, and the largest other region to remove.

**Why.** Parsing takes tens of seconds; caching the parsed form makes startup
instant. A separate metadata mirror means listing the manage screen never reads
a dataset.

### 3.9 Traffic and layers

**What.** The two dead buttons in the navigation control stack now do real,
honest things.

**How.**

- **Traffic** toggles a congestion overlay computed from Valhalla's own per-stretch
  `length`/`time`, binned **relative to the route's median speed** — "slower than
  the rest of this trip", not an arbitrary km/h threshold. Enabled only when a
  provider produced a verdict; otherwise disabled with the reason in its
  `aria-label`, the status line and the layers panel.
- **Layers** opens a panel listing only layers with a real backing source.
- **`progressAlong` is driven by the driver's actual position**, snapped onto the
  route and rejected beyond the off-route threshold. The timer survives only when
  no fix places the car on the route.

**Why.** A dead button in a driving app is worse than no button. And `estimateTraffic()`
is deliberately unused: it bins by point spacing and labels everything `unknown`,
so painting from it would be drawing fiction — no imagery source exists for
satellite either, so that layer was omitted rather than shipping a grey rectangle.

### 3.10 Location

**What.** Real position, speed and heading.

**How.** `src/nav/location.ts` subscribes to `navigator.geolocation` — the
WebView's own API, backed by the platform LocationManager — falling back
device → browser → simulated, with the active mode always shown in the status
pill so it is never ambiguous.

**Why.** `@capacitor/geolocation` was tried first and **failed on device only**:
its native object is a Proxy, and awaiting the returned value calls `then()` *on
the plugin*, failing with `Geolocation.then() is not implemented on android`.
There is no proxy in a browser, so browser testing could never have caught it.
The WebView API returns a real Promise and is the same path the browser build
already exercises, so device and desktop share one implementation.

### 3.11 Release pipeline

**What.** Public repo; a tag produces a release with an APK.

**How.** `.github/workflows/ci.yml` runs typecheck → unit tests → build → E2E
with **both** fixture formats → screen coverage at three viewports, uploading
screenshots as artifacts. `.github/workflows/release.yml` re-runs typecheck, unit
tests and the build, then compiles the APK on `v*` tags and attaches it to a
GitHub Release with install instructions. The Release workflow deliberately does
**not** re-run the browser suites — they need Chromium and roughly two minutes,
and the CI workflow is already the gate on the same commit.

**Why.** Tag-per-change was requested explicitly, and it makes every fix
independently revertible and independently verifiable.

**A CI bug this record should not hide.** The screen-coverage step was added in
v0.8.0 and failed on *every* run afterwards: `ci.yml` started `vite preview` on
port 4192 while `screens.mjs` defaulted to 4193, so the step connected to nothing
and reported `ERR_CONNECTION_REFUSED`. Seven consecutive pushes were red and I
did not notice, because I was verifying locally rather than reading the CI
status. Both now use 4192 explicitly. The lesson: "CI runs the full gate" is only
true if someone reads the run results.

---

## 4. Bugs found and fixed

Every one was invisible until something forced it into the open. Several were
found only by the tests written to check them.

### 4.1 Catastrophic

**Inverted one-way direction flags** — no edge was ever created.
Flags mean "direction *permitted*", but the builder tested
`!(flags & FLAG_ONEWAY_B)`. For a normal two-way road (flags = 3) that is
`!(2)` = false, so nothing was added. The fixture builds **288 directed edges**
once fixed; before the fix it produced a graph with almost no edges at all, 73
nodes with no incident edge, and every route returning `null`. The single
highest-impact bug in the project — and invisible until the fixture made me
count edges instead of assuming they existed.

**Merged graphs turned every two-way road one-way.**
Dedup keyed on the *unordered* node pair, so the reverse record collided with
the forward one already stored and was dropped. Routing in the reverse direction
returned `null` — cross-region routing was broken.

**The offline fallback crashed on long routes.**
`Math.min(...geometry.map(...))` spreads one argument per point and overflows the
stack past ~125k points — trivially reached on a provincial extract, and inside
the code path that exists to save a trip when signal drops.

**Unitless `line-height` blanked all text.**
Tokens declared `lineHeight: 32`. React serialises that without a unit, so it
reached CSS as a *multiplier* — a 768px line box on a 24px font. Glyphs were drawn at the
vertical centre of that box, far below it, and clipped away by `overflow: hidden`.
`elementFromPoint` kept reporting a normal-looking box, which is why it read as a
paint bug for so long. The brand title, subtitle, hint card and buttons were all
blank. Now pinned by a type that makes a bare number a compile error.

### 4.2 Correctness

- **Spatial index aliased cells 131° apart.** `(floor(lon/cell) << 16) ^ …`
  coerces to int32, so the longitude cell index exceeded the 16 bits the shift
  preserves. Cells 131° of longitude apart — up to 14,600 km at the equator,
  ~9,000 km at mid-latitudes — shared a bucket, so `nearest()` near the
  antimeridian searched the wrong side of the planet.
- **`pairKey` aliased node pairs above 2^21 nodes** (directed variant: 2²⁰). A
  province is well past that, so distinct roads collided and border roads
  vanished. Both are now nested `Map` keys, which cannot overflow.
- **Off-route distance measured in degrees.** A degree of longitude is ~cos(lat)
  smaller than a degree of latitude, so an east–west deviation was understated by
  roughly a third at mid-northern latitudes and fell under the detection
  threshold — broken in the direction it most needed to work.
- **Every online search was malformed.** Nominatim's `viewbox` was built
  `[lat, lon]` when the API documents x as longitude — Berlin requested as
  lon 53.1, lat 14.
- **Valhalla:** `summary.length` passed through in km while consumers expected
  metres ("Distance 0 m"); the arrival point was duplicated; every leg after the
  first was discarded.
- **`bestFor` returned the loosest bbox**, so a point inside a loaded city routed
  against the province-wide graph.
- **Relaxing a one-way masked flags instead of clearing them**, turning a usable
  road into one impassable in neither direction.
- **`snapToPolyline` returned `Infinity`** for a degenerate line, which reads as
  "infinitely off route".
- **Two-point routes could never complete** — the segment index is always 0, so
  arrival never fired.
- **`Place.bbox` used Nominatim's `[S,N,W,E]`** while the whole app uses
  `[W,S,E,N]`.

### 4.3 UI

- **Occluded first list row** — `padding-top: 0` under an absolutely-positioned
  app bar hid it on every list screen.
- **Narrow-screen overflow** — a hard `min-width: 420px` on a 412dp phone, an ETA
  bar pushing buttons off-screen, three 156dp buttons needing 468px.
- **Category chips searched names for the literal word "city"** and matched
  nothing; they now filter by tag category.
- **Side arrivals rendered as a centred pin.** `destination-left` and
  `destination-right` were declared in the icon union and mapped from Valhalla
  maneuver types 5 and 6, but had no `case` in the switch, so they fell through
  to `default`. `test/icons.spec.ts` now asserts every declared kind renders
  distinct geometry, which is what catches a missing case.
- **The status pill named the selected engine, not the serving one.** Pin a
  hosted provider, let it fail, and the offline engine answered while the pill
  still read "Valhalla — FOSSGIS" — a local route wearing a hosted provider's
  name, implying turn-by-turn the offline engine does not produce. Invisible
  because the two only diverge on failure, which the browser suite never
  provoked. Fixed with §3.6.1.
- **Invisible nav icons** were the same *kind* of bug as above: a hardcoded
  default colour rather than one inherited from context.

### 4.4 Device-only

Both found by booting an Android 14 emulator and installing the APK — neither was
reachable from browser testing.

- **Geolocation was broken on device** (`Geolocation.then() is not implemented on
  android`). See §3.10.
- **System bars overlapped the app bar.** Android 15 draws edge-to-edge and the
  WebView reports no safe-area insets, so `env()` stayed 0. The activity is now
  immersive — which is what Android Auto does anyway.

### 4.5 Build hygiene

**`npx cap sync` never prunes removed files**, so stale JS chunks were packaged
into the APK and served at runtime — which made a fix look like it had not
landed, and sent me chasing a "still broken" error twice. `npm run sync` now
clears the asset directory first.

---

## 5. Architecture decisions

### 5.1 Capacitor over Expo

**Decided:** Capacitor. **Why:** the map is MapLibre GL (WebGL) and the OSM parser
runs in a Web Worker. Expo/React Native would mean sacrificing one or the other,
or wrapping a WebView anyway — in which case Capacitor is the honest choice. The
secondary benefit proved decisive: the web build is directly testable in a
browser, so most iteration never needed an emulator at all.

### 5.2 Ferrostar not used

**Considered.** Ferrostar is a mature TypeScript navigation SDK with Valhalla
support and a WASM core. It was rejected because it duplicates what the built-in
engine already does, adds a Rust/WASM build dependency, and — decisively — offers
no offline advantage here, since its offline story still requires a hosted
routing provider. Building the engine directly gave full control over the OSM
ingestion path that the multi-region requirement depends on.

### 5.3 Valhalla is not the on-device default

**Answering the earlier question directly:** self-hosting Valhalla on Android is
*not unreasonable* — Valhalla 3.5+ builds with CMake and the NDK route is known.
It is unreasonable as a 30-minute task: protobuf, boost, luajit, prime_server,
sqlite3, GEOS and zlib all need arm64 sysroot variants, and the effort is
measured in days with a real chance of ending in a linker error. Pre-building
Valhalla tiles on a desktop does not remove this — it still needs
`valhalla_service` compiled for arm64 to consume them.

So the default engine is TypeScript, and Valhalla remains a selectable provider
for anyone who *does* want to do the native build.

### 5.4 Web-first, with `navigator.geolocation` rather than the Capacitor plugin

See §3.10. Two implementations of the same thing that can silently diverge is
worse than one that works on both platforms.

### 5.5 Immutable shared tokens

Design tokens live in `theme.ts` and are consumed as typed objects. Bug 4.1's
root cause was a *type* gap, so the fix was a type: `TypeToken` pins `lineHeight`
to `` `${number}px` ``, making the original mistake a compile error rather than
invisible blank text.

### 5.6 Degrade, never fail

A recurring principle across providers, traffic, location and persistence: every
optional capability returns a typed "unavailable" verdict instead of throwing,
and the UI states what is actually known. Nothing in this app implies data it
does not have.

---

## 6. Project layout

```
src/
  App.tsx                ~1800  screens, navigation state, keyboard shortcuts
  theme.ts                 143  AAOS design tokens (colour, type, layout, shape)
  icons.tsx                345  29 maneuver kinds + system icons, hand-drawn SVG
  geo.ts                   173  polyline codec, haversine, formatting, snapping
  styles.css                     layout, insets, responsive rules

  osm/
    engine.worker.ts       923  parse -> graph -> index -> gazetteer, + A*
    pbf.ts                 584  .osm.pbf protobuf reader
    merge.ts               318  union-find merge of adjacent extracts
    regions.ts             382  RegionLibrary, catalogue, bbox helpers
    engine.ts              186  worker client + GeoJSON mirroring
    tags.ts                 36  shared node-tag filter

  nav/
    valhalla.ts            249  Valhalla /route client
    providers.ts           ~350 provider chain, attempt trace, connectivity
    engines.ts             ~230 engine selection, readiness, provenance
    geocode.ts             178  Nominatim client, 1 req/s throttle
    traffic.ts             163  fastest-of-N-alternates traffic verdict
    location.ts            138  device/browser/simulated location
    offroute.ts            107  deviation detection and reroute origin
    maneuver.ts             85  Valhalla maneuver codes -> icons

  map/
    MapView.tsx            272  MapLibre view, tile/offline style switch
    style.ts               337  Google Maps cartography palette

  regions/
    RegionsScreen.tsx      531  manage, catalogue, cross-region route test
    store.ts               185  RegionLibrary singleton, per-region workers
    persist.ts             615  IndexedDB caching of parsed datasets
    download.ts           1270  streaming downloader

test/            418 unit tests, 13 files
test/e2e.mjs           34 browser checks, built bundle
test/screens.mjs        32 checks x 3 viewports (96 total)
tools/osm2pbf.mjs        XML -> PBF encoder (builds the test fixtures;
                            extract slicing is done by osmium on a desktop)
```

---

## 7. Known gaps

Ordered by how much they matter.

1. **Never run on physical hardware.** Everything is browser-verified plus one
   Android 14 emulator. WebView behaviour, real GPS quality, SAF file import and
   on-phone memory pressure are unproven. This is the largest remaining risk.
2. **SAF file import untested on device.** The picker UI was not automatable over
   adb; browser-tested only. Re-confirmed while building the engine screen: the
   file picker cannot be driven through `adb shell input`, so device runs start
   with no map loaded and the offline engine correctly reports
   "No offline map loaded".
2b. **Three untraced launch warnings.** `Expected value to be of type number, but
   found null instead` × 3 on every cold start, including the v0.11.1 baseline.
   Pre-existing, not a regression, and not yet traced to a source.
3. **Parse is not streaming.** The download streams; `OsmEngine` reads the whole
   file, so peak memory during parse is roughly twice the file size — workable but
   tight for a 900 MB province. Documented in the module header, not solved.
4. **No offline vector tiles.** Offline the map draws from `.osm` geometry, so it
   is sparse when zoomed out.
5. **Offline turn-by-turn infers turns** from bearing changes. Real instructions
   need Valhalla.
6. **zstd PBF blobs are rejected by name.** Geofabrik still ships zlib, so this is
   future-proofing only.
7. **Emulator cutout band.** A black band remains where the emulator simulates a
   display cutout. Believed cosmetic and device-specific; not confirmed.
7b. **App bar and grid cell are CSS literals, not tokens.** `96px` appears 9
   times in `styles.css` and `158px` once; `theme.ts` has no `APP_BAR` or
   `GRID_CELL` token. They are the correct AAOS spec values, so this is a
   consistency gap against requirement #2 rather than a visual one.
8. **Rerouting is implemented and tested in isolation** (`nav/offroute.ts`, speed-
   scaled threshold, 6 s confirmation hold, reroute origin from the projected
   point) but is **not yet wired into the navigation screen**, so the app does not
   currently reroute on its own.
9. **Optional: NDK cross-compile Valhalla** to replace the local engine with real
   turn-by-turn.

---

## 8. Commands and workflows

```bash
npm install
npm run dev          # vite dev server
npm test             # 418 unit tests
npm run e2e          # 34 browser checks against the built bundle
npm run build        # typecheck + production build
npm run preview      # serve the built bundle
npm run sync         # build, clear android assets, cap sync
npm run apk          # sync + gradlew assembleDebug
npm run typecheck
```

**JDK 21 is required.** Gradle 8.11 cannot run on Java 25
(`Unsupported class file major version 69`). `npm run apk` defaults `JAVA_HOME`
to JDK 21.

### Releasing

```bash
npm test && npm run e2e
git commit -am "..." && git tag -a v0.12.0 -m "..." && git push origin main --tags
```

The Release workflow runs typecheck, unit tests and the build, then attaches the
APK; the browser suites run on CI for the same commit. 13 releases so far (15 tags; `v0.7.0` and `v0.10.0` have tags but their Release
runs failed):
v0.1.0 → v0.11.0.

### Android device testing

```bash
sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
avdmanager create avd -n canopy -k "system-images;android-34;google_apis;x86_64" -d pixel_6
sudo gpasswd -a "$USER" kvm          # /dev/kvm is root:kvm 0660
sg kvm -c "$ANDROID_HOME/emulator/emulator -avd canopy -no-window -no-audio -gpu swiftshader_indirect"
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
adb emu geo fix <lon> <lat>          # required, or the app reports "Simulated GPS"
adb logcat -d | grep -i "Capacitor/Console"
```

`adb emu geo fix` matters: without a real position the location-driven route
progress and off-route detection cannot be exercised.

### Serving for manual testing

```bash
node /tmp/opencode/serve/serve.mjs     # 0.0.0.0:8080
```

App at `http://192.168.1.83:8080`, APK at `/dl/canopy-nav.apk`.

---

## Attribution

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Routing via [Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OpenStreetMap projects. Base tiles from
[OpenFreeMap](https://openfreemap.org/). Design specifications from Google's
*Design for Driving* documentation.
