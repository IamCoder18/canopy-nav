# Canopy Nav — Status & Design Record

An Android app that recreates the **Android Auto / Google Maps** navigation UI,
with **fully offline OpenStreetMap routing**.

**Stack:** Capacitor + React 19 + TypeScript + Vite + MapLibre GL
**Repo:** https://github.com/IamCoder18/canopy-nav
**Latest release:** v0.11.3 (APK attached); main is ahead with §3.11.1, §4.1, §4.6–4.8, and
§3.17–3.18. **Requirement #10 is now implemented** — cross-region routing merges the extracts
rather than stitching them at a bounding-box midpoint (§3.18), and §3.5.2's correction is
superseded. §3.17 closes the ETA gap that this document called the most dangerous readout in
the app.

---

## Table of contents

1. [Everything that was asked for](#1-everything-that-was-asked-for)
   — including row 10, corrected from "Done" to **Not done** (§3.5.2)
2. [Verification state](#2-verification-state)
3. [Features: what, how, why](#3-features-what-how-why)
4. [Bugs found and fixed](#4-bugs-found-and-fixed)
5. [Architecture decisions](#5-architecture-decisions)
6. [Project layout](#6-project-layout)
7. [Known gaps](#7-known-gaps)
8. [Commands and workflows](#8-commands-and-workflows)
9. [The plan, and what happened to it](#9-the-plan-and-what-happened-to-it)
10. [The audit pass](#10-the-audit-pass)
   — [claims that were false](#101-claims-that-were-false)

---

## 1. Everything that was asked for

This is the full list of requests made during the project, and where each one
stands. **Bold** = fully working and verified.

| # | Request | Status | Where |
|---|---|---|---|
| 1 | Android app using Expo **or** Capacitor — agent's choice | **Done.** Capacitor chosen (§5.1) | — |
| 2 | Visually mimic an Android Auto screen as closely as possible | **Done.** AAOS design tokens taken from Google's published specs. App bar and grid cell are now real tokens rather than CSS literals (§3.14) | `src/theme.ts` |
| 3 | Prefer TypeScript | **Done.** ~10,400 lines TS/TSX. Exactly one hand-written Java file on Android (`MainActivity.java`, immersive mode only) plus XML themes; everything else is TypeScript | `android/` |
| 4 | Other libraries allowed (e.g. Ferrostar) | Considered and rejected — Ferrostar duplicates what the built-in engine does and adds no offline win here | §5.2 |
| 5 | Support `.osm` files | **Done.** Both formats read natively: XML via a chunked scanner, `.osm.pbf` via a protobuf reader. The PBF coordinate bug (§4.1) meant this was *not* working for real extracts until this revision | `src/osm/engine.worker.ts`, `src/osm/pbf.ts` |
| 6 | Use Valhalla for car navigation | **Done** as an optional provider; **not** the on-device default (§5.3) | `src/nav/valhalla.ts` |
| 7 | Use Nominatim for geocoding start/destination | **Done** as an optional online provider | `src/nav/geocode.ts` |
| 8 | 100% local, no WiFi | **Done.** Offline engine, offline gazetteer, offline map rendering, offline persistence | §3.2–3.4 |
| 9 | Multi-region: download by city/province (Alberta, BC…), route between them | **Partly done.** Download, streaming, catalogue and cross-region *search* all work. **Cross-region routing does not route correctly** — it stitches at a bounding-box midpoint rather than merging; see row 10 and §7 gap 1 | §3.5 |
| 10 | Merging the two regions rather than stitching | **Done.** `merge.ts` is now called. Cross-region routing is one A\* over a merged graph, cached per region set, behind a memory guard that refuses with a reason rather than returning a wrong line. Requirement was previously recorded as **NOT DONE**; §3.18 is the implementation and §3.5.2 is superseded | `src/osm/regions.ts`, `src/osm/mergeguard.ts` |
| 11 | Is self-hosting Valhalla on Android unreasonable? | Answered: not unreasonable, but not achievable in the time available (§5.3) | — |
| 12 | Keep hosted Valhalla as an option | **Done.** Three hosted presets plus a custom endpoint — FOSSGIS, Simplerouting.io, and your own `valhalla_service` — each individually selectable and probeable, alongside the offline engine | §3.6, §3.6.1 |
| 13 | Handle losing connectivity mid-trip | **Done.** Provider chain + snapshotted route + honest degradation | §3.7 |
| 14 | GitHub repo (public) | **Done** | [repo](https://github.com/IamCoder18/canopy-nav) |
| 15 | CI that builds a release with the APK on tags | **Done.** 15 releases, APK attached automatically (v0.1.0 was uploaded by hand) | `.github/workflows/release.yml` |
| 16 | Small increments: one fix/feature per release | **Done.** 17 tags, 15 releases | §8 |
| 17 | Unit tests for everything; subagents for tests and browser verification | **Done.** 702 unit tests across 30 files, plus 2 browser suites | `test/` |
| 18 | Every screen and function verified in real Chromium at mobile size | **Done for what the suites cover.** 10 screens at 3 viewports (50 checks each, 150 total), plus 39 e2e checks covering engine selection, provenance, a streamed import and the full off-route reroute flow — the last being the gap this requirement once named as uncovered. Not covered: cross-region routing (§7 gap 1), and the emulator is not a phone | `test/screens.mjs` |
| 19 | Keep going until every issue fixed | **Ongoing.** See §7 for the gap list and §9 for what has actually been built and what has not, including the fixes that measurement contradicted | — |
| 20 | Host on 0.0.0.0 so it can be tested | **Done.** `npm run serve` (`tools/serve.mjs`), in the repo rather than `/tmp`; APK served at `/dl/canopy-nav.apk` | §3.14 |
| 21 | Update STATUS.md continuously | **This document** | — |

---

## 2. Verification state

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | **0 errors**, 27 warnings (ratchet — see §10.3) |
| Unit tests | `npm test` | **792 passing**, 36 files |
| End-to-end | `npm run e2e` | **44 checks** against the built bundle |
| Screen coverage | `node test/screens.mjs` | **53 checks × 3 viewports = 159** (phone-portrait 412×915, phone-landscape 892×412, head-unit 1280×720) |
| Bundle budget | `npm run bundle` | entry 105.8 kB / 130, initial 110.3 / 150, largest 281.6 / 300, total JS 412.3 / 460 (gzip) |
| Offline cold start | verified in-browser | reload with the network off renders the app: 5 tiles, map sized, 0 console errors |
| Release | v0.11.3 tag | **CI green, Release green**, APK attached |
| APK | `npm run apk` | debug APK, `com.canopy.nav`, minSdk 23, targetSdk 35 |
| Device | Android 14 emulator, API 34, 2340×1080 | installs, runs, **zero console output**, real GPS confirmed |

The e2e count moved from 39 to 44 and the screen count from 150 to 153 in §10,
both because the suites gained checks for defects the audits found. The lint and
bundle rows are new *gates*, not new measurements: before §10 nothing failed when
the entry chunk grew or when a hook dependency went stale, because nothing was
watching.

**Every count in this table is measured**, by counting `PASS` lines from an
actual run or by counting call sites in the source. Three figures in this
document were wrong at some point, and each time the error was the same shape: a
number written down once and never re-read.

- The e2e count was recorded as 23 when it was 33.
- The screen-coverage figure was recorded as "29 checks × 3 = 87", which no
  configuration could produce. `screens.mjs` calls `visit()` 11 times per
  viewport, and each visit emits 3 checks, plus 2 standalone ones: 35 per
  viewport, 105 on the all-pass path at the time; it now runs 50 per viewport, 150
  in total, after the navigation controls gained coverage (§4.8).
- **The screen suite was running at 42 checks, not 105**, across a month of
  commits, because of a regression described in §9. It reported "all checks
  passed" the entire time. This is the same failure mode as §3.16's red CI runs:
  a green result nobody re-derived is not a green result.

That third one matters most, because the gate that exists to catch layout bugs
was silently visiting four screens instead of eleven — and when it was restored
it failed immediately, exposing three real 412dp overflow bugs (§4.6).

**Note on the device gate — superseded.** This section previously recorded three
`Expected value to be of type number, but found null instead` warnings on every
cold start, noted as pre-existing and traced to nothing. They have since been
diagnosed and fixed.

**How they were found.** A subagent was given the symptom, the constraint that it
was pre-existing (proved earlier by rebuilding the v0.11.1 baseline APK and
diffing logcat), and the instruction that a negative result with evidence was a
fine answer. It captured the console location, then served controlled variants
of the upstream style to isolate the offending layers one at a time.

**What they were.** Never app code. MapLibre's expression parser throws when an
order comparison (`<`, `<=`, `>`, `>=`) compares an untyped `["get", …]` against a
number and the property is absent, then `StyleExpression.evaluate` catches it and
logs the message — once per layer, on the first tile containing such a feature.
Three layers in OpenFreeMap's `liberty` style do exactly that:
`highway-shield-non-us`, `highway-shield-us-interstate` and `road_shield_us`, all
filtering on `["<=", ["get", "ref_length"], 6]`. A named road with no route ref
has no `ref_length`. The filter result was correct throughout; only the log was
noise, but it read as a fault in this app on every launch.

**The fix** (§3.15) guards those comparisons in `buildStyle`. Verified at **0**
occurrences in Chromium after panning and zooming through dozens of tiles, against
3 before. The device gate above is now genuinely clean: `adb logcat` filtered for
`Capacitor/Console`, `AndroidRuntime` and `FATAL` returns **nothing at all** on a
cold start, where the same filter previously returned three warnings per launch.
That was the last known console output in the project.

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
| `pbfgeo.spec.ts` | 6 | absolute coordinates against the PBF spec, via the real encoder — the nanodegree regression |
| `engines.spec.ts` | 38 | engine selection policy, plan ordering, per-engine readiness reasons, the attempt trace, strict mode |
| `reroute.spec.ts` | 23 | off-route confirmation window, storm guards, backoff growth, tracker reset semantics, banner content |
| `stream.spec.ts` | 30 | streaming XML parse ≡ whole-file parse across chunk sizes, incl. 1-char and seeded fuzz; progress; degenerate input |
| `mapstyle.spec.ts` | 20 | offline style LOD: every line layer has a low-zoom floor, arterials branch on class, layer ordering, no duplicate ids |
| `serve.spec.ts` | 16 | test-server path containment (plain, encoded, dot-segment traversal) and no side effects on import |
| `theme.spec.ts` | 11 | `theme.ts` ↔ `styles.css` token-name agreement, fallbacks present, `:root` declarations |
| `styletiles.spec.ts` | 9 | tile-style order-comparison guard: the actual shield filter, short-circuit shape, recursion, idempotency |
| `progress.spec.ts` | 29 | the three ETA properties as properties: monotone, never zero before arrival, last-good-kept when the fix is unusable — plus `snapAlong` in metres and `formatDistance` not rounding to zero (§3.17) |
| `mergeguard.spec.ts` | 13 | merge memory guard: three outcomes, the boundary at ratio 1, scaling with region *count*, and that the source graphs count because they stay resident (§3.18) |
| `tdz.spec.ts` | 5 | no `useMemo` in `App` closes over a binding declared later in the component body (§3.19) |
| `app-render.spec.ts` | 3 | `App` renders at all; the root landmark is labelled and names the current screen (§3.19) |

**Three counts in this document have now been wrong at least once, and each was wrong the
same way.** The e2e count (§2). The screen figure, recorded as both "29 × 3 = 87" and "50 × 3
= 150" in different sections of *this* file while the true value was 51 × 3 = 153 — §2 was
right and §6 and §9.2 were stale, which is the more awkward direction, because the correct
number was sitting in the document the whole time. And the unit-test total, which sat at 702
through three commits that added 53 tests. A number that is written once and never
re-derived is a claim, not a measurement, and every one of these was found by re-running the
gate rather than by reading harder.

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
  list rows and `R2`=8dp / `R4`=full corner radii are tokens in `theme.ts`. The
  96dp app bar and 158dp minimum grid cell were CSS literals in `styles.css` and
  are now `STRUCTURE.APP_BAR` / `STRUCTURE.GRID_CELL` (§3.14), published as CSS
  custom properties with literal fallbacks so a missing token cannot collapse the
  layout.

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

1. **Parse.** Both formats, whole or streamed (§3.12). XML via a streaming regex
   scanner; PBF via
   `src/osm/pbf.ts`, a protobuf reader handling BlobHeader/Blob framing, zlib
   inflation through `DecompressionStream`, and DenseNodes delta decoding.
   The format is sniffed from the file's first 16 bytes in the *client*
   (`src/osm/engine.ts`), before the worker is told which format it has, and
   falls back to the extension only if the bytes are inconclusive. Both formats
   arrive through the same picker, which is why the bytes are the primary signal.
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

The fixture is a 9×9 Manhattan grid, so the shortest *distance* between two
corners is hand-computable and is what `engine.spec.ts` asserts against (a
metre bound, both above and below the optimum). **No test asserts a duration.**
An earlier version of this document claimed a figure of 860.4 s was "asserted
against a hand-computed bound"; there is no such assertion and no such number in
the repo, so the claim has been removed rather than softened. There is also no
separate Dijkstra reference implementation to check optimality against, which is
the honest limit of what is verified here: the distance bound is a sanity check
on a grid, not a general optimality proof.

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

#### 3.5.2 Merging — how cross-region routing actually works

**Superseded.** This subsection used to be a correction: the merge existed, was
correct, was thoroughly tested, and the app never called it. It is now wired in.
The implementation is §3.18; what follows is kept because the *shape* of the old
bug is the most useful thing in this section, and because the test fixture that
could not detect it is still the most instructive artefact in the repo.

**What used to happen.** `src/osm/merge.ts` was imported by three spec files and by
nothing in `src/`. Cross-region routing went:

```
RegionLibrary.route()  ->  plan()  ->  boundaryPoint(a, b)
                                     |
     routeIn(regionA, origin, mid)  +  routeIn(regionB, mid, destination)
                                     |
                     concatenate geometries, sum metres and time
```

`RegionLibrary.route()` returned `{ ..., stitched: true }` for this path — the code
named what it was doing.

**Why that was wrong, not merely imperfect.** `boundaryPoint` returned the midpoint
of the closest points between the two regions' **bounding boxes**, after rejecting
pairs further apart than `ADJACENCY_GAP_M`. That point came from box arithmetic
and had no relationship to the road network. Each leg then snapped it to the
nearest node *within its own region*. For Calgary to Vancouver the driver was
routed via whichever node happened to be nearest a box-derived midpoint — in the
Rockies, at the closest point between two rectangles, rather than the actual
highway crossing.

The failure mode was not a visible seam. The two legs shared a point, so the line
was continuous. It was a **wrong route**, which is worse, because it looks right.

**Why it was never noticed, and why the tests could not have caught it.** This is
the part worth keeping. Single-region routing is unaffected and is the common case;
the cross-region path only runs when two regions are downloaded and the two ends
fall in different ones.

But there is a second, sharper reason, and it is the generalisable one. **The
existing cross-region test fixture cannot distinguish stitching from merging, and
never could.** Its two bboxes touch along a shared edge, so `boundaryPoint`
returns the centre of their overlap — which, for a straight road at lat 0, *is*
the shared OSM node. The stitched route and the merged route are byte-identical.
`test/merge.spec.ts` has the same blind spot from the other direction: its
`makeRegion` helper defaults every bbox to `[0, 0, 1, 1]`, so the boxes are
identical and the stitch point lands on the shared span's centre.

So requirement #10 sat under a row marked "Done", then under a row marked "Not
done", with roughly 800 lines of tests passing throughout, because every test that
touched this code was structurally incapable of distinguishing the two
implementations. It is the same failure as §4.1 (parser and fixture sharing a wrong
constant, so the round trip agreed with itself) and §4.6 (a suite visiting four
screens instead of eleven and reporting success). Three instances of one pattern:
**a test that cannot fail is worse than no test, because it is counted.**

The replacement fixture is in `test/regions.spec.ts` and is built to defeat exactly
this: the real through-road is 1–2–3, the bboxes overlap in a rectangle centred
11 km off that road, and each extract carries a `Loop` way reaching the centre.
Stitching hands the driver from one `Loop` to the other, a **fourfold** detour
through a junction that exists only as box arithmetic; merging takes 1–2–3. All
four new assertions were verified to fail against the old stitching code.

`RoadGraph.regionOf` is still serialised for every region by `regions/persist.ts`
even though it is only meaningful for merged graphs. It is now at least reachable
— a merged graph is one the app can build — but the persisted bytes are still
wasted for single-region entries.

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

**Default.** `{ preferred: 'local', allowFallback: true }` — the offline engine
first, hosted engines behind it for pairs the extract does not cover. Strictly
more capable than the previous behaviour, which was local-only with no fallback.

### 3.7 Mid-trip connectivity loss

**What.** Signal drops halfway through a drive.

**How.** Three mechanisms. Note that rerouting is *not* among the things lost with
signal — the offline engine and the snapshotted geometry are enough to recompute a
route with no network at all, which §3.11.1 depends on.

1. **Provider chain.** Online engines are tried when a network is believed to
   exist; the local engine is always the fallback, so a route never fails
   outright. Which engine answered is recorded and displayed (§3.6.1), and the
   driver chooses both the preference and whether substitution is allowed.
2. **Snapshotted route.** Once fetched, geometry, maneuvers, ETA and steps are
   all resolved client-side. Guidance continues with no network at all. Rerouting
   (§3.11) works from the snapshotted geometry too.
3. **Honest degradation.** Traffic is labelled by its real confidence
   (`live` / `estimated` / `none`); verified traffic data is *kept* when signal
   drops, labelled "last known — no signal to refresh", because blanking true
   information is worse than showing it with a caveat.

**Why.** A navigation app that loses guidance when a tunnel eats the signal is
useless. Degrading to the offline engine costs nothing and saves the trip, and
because that engine needs no network it can also *re-route* — so losing signal
costs traffic data and nothing else.

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

### 3.11 Rerouting

**What.** The app notices you have left the route and gives you a new one,
without ever taking the old one away first.

**How.** `nav/offroute.ts` holds the *primitives* — a speed-scaled tolerance, a
6-second confirmation hold, a reroute origin taken from the projected point
rather than the raw fix. `nav/reroute.ts` holds the *policy* — when to act, how
long to wait afterwards, what to tell the driver — as pure functions over a
plain state, so the storm guards are testable without React, timers or a network.
The navigation effect in `App.tsx` supplies the fix and does what the policy asks;
it makes no decisions of its own.

Three invariants, in priority order:

1. **A reroute never removes guidance.** The existing route and its maneuvers stay
   on screen for the whole request, so a driver who is lost is never also left
   without directions. A failed attempt restores nothing because nothing was
   removed.
2. **One attempt at a time.** `busy` latches until the attempt finishes, so a
   fix storm cannot queue requests that would race and overwrite each other.
3. **Back off after failure**, doubling to a 120 s cap. Retrying a dead engine
   every few seconds drains the battery and will not start working on its own.

**Why.** This closes the last gap where an implemented feature was not reachable
by the user. `offroute.ts` had six exports and the app called two, so the tracker
and the reroute origin were unit-tested and never invoked — the app did not
reroute on its own. Requirement #18 named "rerouting mid-turn" as the specific
uncovered flow, and that is now driven end to end in `test/e2e.mjs`: the geolocation
fix is walked over 4 km off the line, held past the confirmation window, and the
suite asserts the driver is told, that guidance survives, and that the notice
clears on return.

Four bugs surfaced while building it, all in the first implementation and all
caught by the tests:

- `finishReroute` reset the tracker on failure as well as success. After a
  *failed* reroute the driver is still off the original route, so discarding the
  tracker threw away the evidence that says so — and the app sat in "suspect" for
  another 6 s window while its own backoff said otherwise.
- The first-failure backoff was 15 s against a 30 s settle, so the first failure
  *shortened* the wait. Retrying a dead engine faster than you would settle a
  fresh route is backwards.
- The rejoin distance was shown for a merely-*suspect* driver, i.e. "rejoining in
  700 m" off a single outlier fix. Now only once the deviation is confirmed.
- `CONFIRM_MS` was private, so the confirmation window was a magic number to any
  caller reasoning about when a reroute is allowed. Exported as
  `CONFIRM_WINDOW_MS`.

### 3.11.1 The frozen-position loop, and three banner defects

**What.** A stuck GPS fix rerouted every 30 seconds, forever. Found by an audit,
not by a test — the tests were all green while it was happening.

**How.** `watchPosition` keeps its last value when a signal drops (tunnel,
revoked permission, cold GNSS), and the error callback never invalidated it. The
reroute effect fed that frozen position to the policy as though it were live, so
the deviation from the line never changed, never cleared, and re-confirmed after
every settle window. **Measured before the fix: 20 requests in ten minutes,
exactly 30 s apart, with `failures` pinned at zero** — because every attempt
*succeeded* and reset the counter. Neither the busy latch nor the backoff could
help; both guard against repeated *failure*, and this was repeated success.

Closed at two levels:

1. `LocationState.stale` is a first-class signal, set when no fix has arrived for
   20 s. The reroute effect refuses to act on a stale position.
2. `madeProgress` requires a candidate reroute to actually move the driver nearer
   the destination. A reroute that does not is evidence of a stale fix, not of a
   driver who is lost.

The second guard is deliberately *evidence-based* rather than time-based, which is
what makes it survive a freeze of any duration: it asks "has anything changed?"
rather than "how long has it been?".

**Also fixed in the same pass, all found by the same audits:**

- **The maneuver banner's distance was wrong.** `distToNext` multiplied a
  shape-index *ratio* between two maneuvers — which carries no distance
  information — by the remaining distance. The headline number therefore shrank
  with the length of the *trip* rather than the next leg: a turn two streets away
  read as half the remaining journey, and the imminent-turn dimming below 40 m
  never fired at all. Now measured along the road.
- **Offline routes showed "0 m / Continue" for the whole trip.** The offline
  engine emits no maneuvers, so `guidance` is null and the banner read
  `localGuidance` for exactly one field — the remaining distance — while ignoring
  the turns it had already derived from bearing change. Since the offline engine
  is the *default*, the largest number on the navigation screen was meaningless
  for most users. It now falls through to the derived turn, and says "Arriving at
  your destination" when there is none.
- **A failure reason survived about one second.** `observeFix` rebuilds `message`
  on every fix, so "API key required" was replaced a second later by a bare
  "retrying in 29 s" and stayed that way for the full wait. `RerouteState.reason`
  now holds it and the countdown folds it in.

### 3.12 Streaming the OSM parse

**What.** Importing a 900 MB province no longer requires holding it in memory
twice.

**How.** `parseOsmXmlStream` consumes an async chunk stream and retains only the
incomplete tail. Everything up to the last safe element boundary is scanned and
dropped. Two details carry the weight:

- `TextDecoder` runs with `{stream: true}`, so a multi-byte UTF-8 sequence split
  across two reads is held in decoder state rather than becoming replacement
  characters. Decoding each chunk independently corrupts every non-ASCII place
  name, subtly, and only on large files.
- The boundary rule is "after a complete `<node>`/`<way>`", expressed with the
  same grammar the scanner consumes.

`parseOsmXml` (whole string) and the streaming path share `scanSegment` and one
boundary function. That is deliberate: two implementations of the same parser
would eventually disagree about a malformed element, and the streaming one is
the one that runs where a silent divergence is hardest to notice. Equivalence is
then a testable property rather than an aspiration.

**Why.** The download already streamed — only the parse did not, so peak memory
was roughly twice the file size. The `ReadableStream` is passed in the *transfer*
list, not cloned: Chrome rejects a cloned stream outright ("a ReadableStream could
not be cloned because it was not transferred"), and transferring also moves the
handle instead of copying it.

PBF still collects to a contiguous buffer. Protobuf framing needs sequential
access, so it cannot be chunked at an element boundary the way XML can. That is
stated at the call site rather than left to be discovered.

Two bugs, both mine, both caught by the tests:

- The first cut rule was "after any `>` whose remainder looks like a tag start",
  which split a tagged node across two segments: the opening `<node id=...>` ended
  one, the `<tag>` children and `</node>` the next, and neither half matched. A
  tagged placemark and its way were silently dropped. Only the
  one-character-at-a-time chunking test catches this, because it is the only
  chunking guaranteed to land inside an element.
- I had commented that a `ReadableStream` is structured-cloneable rather than
  transferable. That is false, and the browser corrected me immediately.

### 3.13 Offline map level of detail

**What.** The offline map is legible when zoomed out, which it was not.

**How.** The geometry was never missing — `roadsToGeoJSON` already mirrors every
road in the dataset into a MapLibre `GeoJSONSource`. The width ramp's first stop
was zoom 10, and a province fits the viewport at about zoom 6, so every road drew
at a single flat pixel. Arterials are now held near their high width down to zoom
6, and the low-zoom value itself branches on class; minor roads moved to their own
layer with a floor and lower opacity when far out; water is floored too.

**Why.** This is a style problem that looked like a data problem, and I had it
filed as a weeks-long MBTiles pipeline before checking. The tell is that one pixel
of motorway is indistinguishable from one pixel of service road: a single
`line-width` expression cannot make one class thick at zoom 6 and another almost
invisible, which is why arterials and minor roads had to become separate layers.

`offlineStyle` moved from `MapView.tsx` into `style.ts` as `offlineStyleSpec`,
taking the overlay layers as an argument. It had to move for the test to be worth
anything — `maplibre-gl` pulls in a DOM — and an earlier draft of the test rebuilt
the layer list locally and asserted against that copy, which would have passed
even if the shipped style had drifted.

**What is not claimed.** These assertions are structural: every line layer has a
floor below zoom 10, arterials branch on class at low zoom, minor roads recede.
They are not pixel comparisons, because the only extract available offline is a
19-way fixture and it cannot show what a province looks like at zoom 6. Asserting
on those pixels would be a reassurance, not evidence.

### 3.14 Structural tokens and the test server

**What.** Two requirements that were marked "Done" now rest on things the repo
owns, rather than on CSS literals and a script in `/tmp`.

**How.** `STRUCTURE.APP_BAR` (96) and `STRUCTURE.GRID_CELL` (158) live in
`theme.ts` and are published as CSS custom properties by `applyThemeTokens()`.
CSS cannot import from TypeScript, so the duplication does not vanish — it moves
from nine call sites to one seam. Every `var()` keeps a literal fallback, because
a token that fails to resolve is `height: auto`: a silently collapsed app bar
rather than an error. `test/theme.spec.ts` pins the contract the type system
cannot see, that `theme.ts` and `styles.css` agree on the names.

`tools/serve.mjs` replaces `/tmp/opencode/serve/serve.mjs` (requirement #20),
with `npm run serve` and `npm run screens`.

**Why.** Neither was a visual or functional bug; both were claims that stopped
being reproducible the moment you looked for them. The server is the one piece of
this project exposed to a network, so its path handling is tested: note the
behaviour is *clamping*, not refusing — `/../../../etc/passwd` resolves to
`<ROOT>/etc/passwd`, which does not exist and falls through to the SPA shell. The
property that matters is that the result never leaves `ROOT`, and that is what the
tests assert.

### 3.15 Tile-style remapping and the type-assertion warnings

**What.** Three console warnings on every cold start are gone, and the tile style
is repainted to Google's palette on the way in.

**How.** `buildStyle()` fetches OpenFreeMap's `liberty` style and post-processes
it: `remapPaint` rewrites fill, line and text colours toward Google's palette,
and `guardOrderComparisons` wraps order comparisons that read a bare property.

**Why the guard exists.** MapLibre's expression parser wraps `<`, `<=`, `>` and
`>=` in a runtime type assertion when one side is statically untyped, so
`["<=", ["get", "ref_length"], 6]` asserts that the value is a number. A tile
feature with no `ref_length` — any named road without a route number — makes that
assertion throw, and `StyleExpression.evaluate` catches it and logs
`Expected value to be of type number, but found null instead`, once per layer, on
the first such tile. Three layers in `liberty` do this:
`highway-shield-non-us`, `highway-shield-us-interstate` and `road_shield_us`.

Wrapping as `["all", ["has", prop], cmp]` makes the comparison unreachable for
features that lack the property, because `all` short-circuits. The filter result
was already `false` for those features, so nothing about what is drawn changes —
only the log. The transform is idempotent, since a remap that wraps twice is a
trap for the next caller even though `buildStyle` always re-fetches.

Worth recording as a process note: this was found by handing a subagent a symptom,
the evidence that it predated the current work, and explicit permission to report
a negative result. It isolated the three layers by serving controlled style
variants, and reproduced the throw against the style-spec alone with no browser.

### 3.16 Release pipeline

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

### 3.17 The ETA readout

**What.** The number on the navigation screen that a driver acts on without
checking.

**What was wrong.** It was recomputed from scratch on every fix, from whichever
part of the route line happened to be nearest, and it had no memory of where the
car already was. Two failures, both measured in the running app:

1. **It could increase while the car drove forwards.** A route that runs beside
   itself — a divided highway, an overpass, a loop back past the way you came —
   has two near-equal candidates, and the nearer one can be *behind* the driver.
   Remaining distance then grew. Observed flipping between `0 m` and `670 m` on a
   36 m move.
2. **It read `0 m` to destination while the driver was 900 m off course.** Past
   the off-route threshold, "closest point on the route" stops being a fact about
   the car and becomes an arbitrary point on a line. If that point was near the
   end, the bar said *arrived*.

The two halves of the app disagreed. `progressAlong` was already monotonic and
already refused untrustworthy fixes; the ETA path did neither, and re-projected
each fix from scratch. So the drawn "already driven" line and the distance beside
it could not both be right.

**How.** Three properties, in priority order, as pure policy in
`src/nav/progress.ts`:

- **Never zero before the last vertex.** Zero remaining means arrived. It is not
  reachable by a car short of the end, structurally rather than by convention.
- **Never increasing as the car drives forward.** You cannot un-drive a road. This
  also rejects GPS jitter, stale fixes and doubling-back routes, none of which
  un-drive it.
- **When the fix is unusable, keep the last trustworthy number.** Blanking true
  information is worse than showing it with a caveat — the same reasoning that
  keeps verified traffic when signal drops (§3.7). But it is never *invented*
  from a fix too far off the line to place the car.

Underneath, `geo.ts` gained `snapAlong`, which measures a position in **metres from
the start** rather than as a segment index. The index could not express three
things: arrival (a multi-vertex line's last segment is never "the destination"),
distance (it counts vertices, so the same road is a different number of steps
depending on tessellation density), and position within a segment (it names the
segment's *start*, reporting a car mid-segment as a whole segment behind).
`vertexAt` is its inverse for the readouts that are inherently per-vertex.

And `formatDistance` no longer rounds a nonzero distance to `0 m`. Snapping 4 m to
the nearest 5 m gives 0, and "0 m to destination" is a statement about the world,
not a rounding artefact — a driver still on the road reads it as *you have
arrived* and stops looking. It rounds **up** to one step, which over-estimates
the distance remaining rather than under-estimating it. A genuine zero still
prints `0`.

**Why the tests are property tests.** `test/progress.spec.ts` drives a whole route
with the geometry that caused the failure, rather than asserting single
hand-picked cases that would only prove those cases. The fixtures that matter are
a route whose three sections run 11 m apart with ±2 m of GPS noise, and a
mid-junction fix reported *between* two levels of road. The first attempt at the
noise fixture passed with the monotonic clamp deleted, because ±2 m cannot flip an
11 m gap — the test was decorative. It was replaced with one that discriminates,
and the clamp, the off-route guard and the zero-floor were each verified to fail
when removed.

### 3.18 Cross-region routing, by merging

**What.** A route whose ends fall in different downloaded extracts.

**How.** `RegionLibrary.route()` merges the participating regions and runs one A\*
over the merged graph. `merge.ts` is unchanged: it was already correct, and the
whole of the previous gap was that nothing called it.

Four things had to be decided, and none of them was the merge itself.

**Where the merged graph lives.** On the library, as a private cache keyed by the
sorted region ids, invalidated in `add()` and `remove()`. Not as a synthetic
`Region`: `add()` fires `emit()`, so a phantom entry would appear in the region
list with a Remove button that deletes nothing, and would be counted in the
"N loaded · X MB" chip and iterated by the gazetteer aggregation. A merge is also
invalid the moment a region is re-imported, which is why the cache is cleared
rather than merely keyed.

**Whether to attempt it at all.** `mergeRegions` holds every source graph, a boxed
JavaScript `Map`/`Array` copy of the nodes and edges, *and* the typed-array result
at once, so peak is 2–3× one graph rather than one. For two provinces that is not a
question of speed. `src/osm/mergeguard.ts` decides from static size **before** any
of it runs, from the graph's own declared shape (≈96 B/node, ≈24 B/edge, both
derived from the actual typed arrays plus the per-query A\* scratch and the spatial
index, not guessed), and has three outcomes:

- **proceed**;
- **proceed, and say the headroom is thin** — below 75% of budget it warns rather
  than hoping;
- **refuse**, with the shortfall and the budget both named in MB.

The middle outcome is the point. A yes/no guard either gets the WebView killed
mid-merge — which on Android is a silent tab kill, not an error — or refuses
hardware that would have coped. `navigator.deviceMemory` is a coarse Chromium-only
bucket and `performance.memory` is non-standard, so when neither answers the guard
*assumes* 512 MB and says it assumed; reading a missing value as unlimited would
be the worst of the three options.

**What to do when it refuses.** Nothing, which is the correct answer. A
cross-region route that cannot be afforded has no honest approximation, because
the line it would replace is the wrong one, and wrong-but-continuous is the worst
thing to hand a driver. `route()` is nullable for three unrelated reasons — no
region covers the pair, no path exists, the merge did not fit — and the caller
cannot tell them apart from the null, so the actionable one is recorded on
`lastRefusal` and surfaced. Telling a driver "no route" when the truth is "this
device cannot compute this route" is how a reachable destination becomes an
unreachable one.

**What stays the same.** `plan()` is untouched. It decides *which* regions a query
needs, and that part was never the bug. `stitched` is now always `false` for a
route the app actually serves, and the flag survives on the return type so no
caller's signature changed — `App.tsx` and `RegionsScreen.tsx` compile unmodified.
`merge.ts` has zero runtime imports (both are `import type`), so importing it into
`osm/regions.ts` creates no cycle.

**Why the memory limit is still the open part.** The guard decides from *declared*
graph size, on a device that will not reliably report its heap. That is a static
estimate against a dynamic constraint, and it is the honest limit of what has been
built: correct for small extracts, and *refusing* rather than guessing for large
ones. Merging two real provinces on a real phone is still unverified (§7).

### 3.19 Two gates for render-time failures

**The problem.** This project tests pure logic under node, with no DOM. That is a
good trade — it is why 792 tests run in eight seconds — and it has a blind spot with
a demonstrated cost.

A `useMemo` callback runs *during render*, so anything it closes over must already
be initialised. The ETA fix added a `routePos` ref **below** the two guidance
memos that read it. That is a temporal dead zone, and reading it throws
`ReferenceError: Cannot access 'routePos' before initialization`. All 747 unit
tests passed. The app rendered nothing but the error boundary's recovery card —
and because the boundary exists and works as designed, it failed *quietly*, which
is the worst way for this to fail. Only `test/e2e.mjs` caught it, because only the
browser suite renders `App`.

**What was added.**

- **`test/tdz.spec.ts`** finds `App()`'s body by brace matching, collects its 81
  component-scope bindings — including array-destructured `useState`, which is most
  of them — and asserts that no `useMemo` callback reads one declared later.
  Scoped to `useMemo` deliberately: an effect runs after the commit and a
  `useCallback` is only *created*, so a click handler reading a later-declared
  helper is fine, and asserting on those would mean asserting on most of the file.
  The wider scan is kept as a printed inventory rather than a failure, because it
  cannot tell the two cases apart. Verified to fail, with a line-referenced
  message, when the ref is moved back down.
- **`test/app-render.spec.ts`** renders `App` through the server renderer with the
  map chunk mocked, so a first-render throw is a unit-test failure. It does **not**
  close the original gap and does not pretend to: on a first render both guidance
  memos return early, because there is no route and no dataset yet, so the bug
  needs a route to exist. What it does buy is that the root landmark and the crash
  card are asserted somewhere cheaper than a browser suite.

**The finding that came out of writing the first one.** The scan immediately
reported `beginRouteProgress` read 100 lines above its declaration — inside a
`useCallback`, therefore harmless, because it only runs on a click. It was moved
anyway, and the ordering rule is now uniform: everything a memo needs is declared
with the memos. The alternative was a permanent, documented, load-bearing exception
to a rule, which is how the original bug happened.

**Why this is in the document at length.** Because the shape is the lesson, and it
is the fifth time in this project's history that a gate reported success while
unable to see the thing it existed to see: §3.16's seven red pushes, §4.6's
screen-coverage regression, §4.1's shared wrong constant, §3.5.2's fixture that
could not distinguish two implementations, and now this. The general form is that
**a green result nobody re-derives is not a green result**, and the corollary that
matters more: a suite that has never been seen to fail has not been tested.

**The audit pass that followed.** With the gates in, three browser audits drove the
app at 412×915 / 892×412 / 1280×720 with geolocation pinned to the on-disk fixture
east of Edinburgh. They returned a ranked set of defects, most of which are closed
in the "Close the defects the browser audits found, measured in Chromium" commit:
preview-actions clipped at 412dp, the home-bar brand truncated to "Ca…",
`nav-controls` overlapping `nav-bottom` by 20dp, `pill-gps` at 4.27:1, the
attribution dark-theme rule being dead against the lazily-loaded MapLibre CSS, an
invalid `color: ink.secondary` inside a stylesheet plus a tofu `⏱` glyph, the
imminent-turn dimming that was computed and never consumed (the same shape as the
§4.6 dead affordances), and the catalogue button whose accessible name read as a
single word. All verified in a live probe before they were declared fixed.

Deferred by name, so they are not lost:

- The offline **inferred guidance is unreachable on the fixture**, because the
  local engine returns a 2–3 point geometry for a short route and the step
  inference loop needs at least seventeen. The honest "No turn-by-turn" empty
  state is correct behaviour for data that has no turns; a route whose geometry
  is too sparse to infer from should either produce steps some other way or say
  so more plainly.
- The primary CTAs and the bottom search controls have no pressed state yet. A
  focus ring exists on every control; the press-down visual is the first thing an
  AAOS designer adds and is the first thing a screen reader assistant does not.
- The Regions catalogue repeats an unavailable entry's reason as a multi-line red
  paragraph that balloons the row to ~365dp at 412dp; row height is nominally
  116dp. Fold the reason into one line and expand on demand.
- The off-route notice touches the maneuver banner's edge at 1280×720. A 0-gap
  border-to-border look, on a surface that has a 12–16dp radius elsewhere.

---

## 4. Bugs found and fixed

Every one was invisible until something forced it into the open. Several were
found only by the tests written to check them.

### 4.1 Catastrophic

**Real `.osm.pbf` extracts decoded 100× too small.** The OSM PBF spec stores
coordinates as integers in units of **1e-7 degrees** — nanodegrees. The parser
divided by 1e-9, and so did `tools/osm2pbf.mjs`, which builds the test fixtures.
The round trip therefore agreed with itself and **every test passed**.

Any real Geofabrik extract, written to the spec, was read 100× too small. Andorra's
42.42 N arrived as 0.4242 — the country in the Gulf of Guinea. Every distance,
every route, every bounding box and every cross-region comparison was wrong, and
nothing on screen said so: the map drew, search returned results, the app looked
like it was working. **This was the most consequential bug in the project's
history.**

It was invisible for the same reason the `.nav-panel` corruption (§4.7) was: a
self-consistent round trip cannot detect a mistake both halves share. Only the
*specification* can, and nothing in the suite was written against it. Fixed in all
three places (both parser paths, the encoder, the test helpers) with the fixture
regenerated, and `test/pbfgeo.spec.ts` now asserts absolute facts — Edinburgh is at
~51.5 N, not ~0.515 — going through the real encoder rather than a helper.

It also means the cross-region gap (§7 gap 1) was partly theoretical until this
fix: there was no correctly-parsed province on the device to stitch between.

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

**A trace that could not explain itself, introduced while fixing the above.**
Adding the attempt trace meant deciding what `degraded` meant, and I first made it
record *every* skip — so a missing endpoint surfaced as a degraded banner entry
and the "no route" message blamed an offline map that had never been consulted.
Four existing tests caught it. The distinction that holds: `degraded` is only
what actually *cost* something (no link, no key), while the trace carries the
full detail including engines that were never reached.

### 4.2 Correctness

- **`strict` mode aborted the engine walk instead of bounding it.** My first
  implementation threw as soon as any pinned engine failed, which is fine for a
  single named engine but makes "any online engine" a lie: its plan *is* three
  hosted engines, and walking between them is precisely what that option means.
  Correct semantics are "the plan is the whole world" — never append the offline
  engine, always explain why nothing answered. Caught by a unit test asserting
  that a strict `any-online` request reaches the second hosted engine and never
  reaches `local`.
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

  *Found later, by reading the two files against each other:*
  `capacitor.config.ts` also set `adjustMarginsForEdgeToEdge: 'force'`, which
  contradicts the immersive activity. Forcing Capacitor to inset the WebView for
  system bars that `applyImmersiveMode()` has just hidden means padding the app by
  the height of chrome that is not on screen, and the config comment described the
  margin handling as the solution — so it documented a mechanism the app does not
  use. Now `'auto'`. This is the same shape as §3.6.1's status pill: two places
  each believed they owned a decision, and the UI was the only thing that could
  say which one was lying.

### 4.5 Build hygiene

**`npx cap sync` never prunes removed files**, so stale JS chunks were packaged
into the APK and served at runtime — which made a fix look like it had not
landed, and sent me chasing a "still broken" error twice. `npm run sync` now
clears the asset directory first.

### 4.6 Four controls the user could not reach

Every one declared, wired to real work, and never invoked. Same class as
`offroute.ts` (§3.11) and found by an audit of props declared-but-unread rather
than by any failing test.

- **No way to clear the route.** `HomeScreen` accepted `onClear`, bound to real
  state-clearing work, and never called it. A destination, once set, was held for
  the life of the session: the red pin stayed on the map and the Continue card
  never went away. The only other clearing paths were importing a file or
  computing a new route. Now a Clear button sits beside Continue.
- **The preview card's Time icon never rendered.** `PreviewRow` declared an
  optional `icon` prop, a caller passed one, and the component neither
  destructured nor rendered it. It also had no styling, so rendering it alone
  would not have lined up.
- **Map taps were a guaranteed no-op.** `MapView` registers a real MapLibre click
  handler and a 550 ms long-press timer; `App` passed neither. Wiring it exposed a
  second defect: the registration effect runs once with `[]`, so its closures
  capture mount-time props and any handler passed later would never be seen.
  Fixed with refs.
- **Dragging a file onto the home screen did nothing.** `onImportFile` was the
  fourth dead prop in this class.

### 4.7 The corrupt CSS rule and a green gate over 4 screens

Four bugs, none of which any test had been in a position to catch, and three of
which were behind a broken gate.

- **A bare git object SHA sat inside `.nav-panel` in `styles.css`**, splitting the
  rule in two. Twelve declarations — `bottom`, `width`, `max-height`,
  `overflow-y`, `pointer-events`, `z-index`, `display`, `padding`,
  `border-bottom`, `text-align`, `color` — ended up after the `.panel-head` rules
  at top level, where a CSS parser drops them. The layers popover kept only
  `position`, `left`, `border-radius`, `background` and `box-shadow`, and since
  `.nav-root` is `pointer-events: none` the panel had no `pointer-events: auto`:
  every row passed clicks to the map underneath. The same orphaned block was
  duplicated inside `@media (max-height: 520px)`, where its
  `max-height: calc(100% - 424px)` goes negative at 412dp tall. Both merged back;
  the short-screen case gets its own values because the tall ones do not transfer.
- **The screen-coverage suite was visiting 4 screens instead of 11.** Unwinding
  after a newly-added screen used `page.goBack()`, but this app navigates by React
  state and pushes no history entries, so `goBack()` left the app for
  `about:blank`. Every later selector then failed, and because each block is
  guarded the run still printed "all checks passed" — while reporting 42 checks
  instead of 105. The gate built to catch layout bugs had been reporting green
  over a third of its scope.
- **Restoring those 63 checks failed immediately**, exposing three real 412dp
  overflow bugs that the regression had been hiding: `.chip` was declared twice
  with conflicting sizes (a 44dp status label and a 76dp interactive chip, the
  later block winning for both); the Regions catalogue row's action cluster was
  wider than the row and `flex-shrink: 0` defeated wrapping; and the app bar's
  status chip, "1 loaded · 13.0 KB", ran off the right edge of a 412dp screen.
- **`adjustMarginsForEdgeToEdge: 'force'` contradicted the immersive activity**
  (§4.4's second item), insetting the WebView for system bars that
  `MainActivity` had just hidden.

The common thread is that each of these was invisible to a passing gate, and two
of them were found by auditing rather than by running anything. The `.nav-panel`
corruption is the sharpest: it had been committed, it broke a control, and the
screens suite had not visited that screen for a month.

### 4.8 The screen suite had zero coverage of the navigation controls

Added in the same pass as §4.7, because the reason these survived is that
nothing ever opened the panels they live in. `test/screens.mjs` now drives the
navigation screen, opens the layers popover, and asserts it is **sized, clickable,
stacked above the map, populated, and closes**.

Verified as a real test rather than a decorative one: deleting
`pointer-events: auto` from `.nav-panel` — the exact shipped regression — turns
three viewports red with "panel none / row auto".

A note on the process, because the mistake is the useful part: the first attempt
to wire `onMapClick` put a `useRef` **inside** the effect body. A hook called in
an effect is not a hook, and the app rendered a blank screen with React error
#321. Only the screen suite noticed, because a blank home screen is exactly what
"home renders content" checks for.

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

Every line count below is `wc -l`, re-measured for this revision. An earlier version of
this section carried thirteen stale ones; §9.3 records a previous audit finding three, and
the same class of error keeps recurring because a line count is cheap to write and never
checked. Treat this table as a snapshot with a date, not a fact.

```
src/
  App.tsx                2873  screens, navigation state, keyboard shortcuts
  theme.ts                177  AAOS design tokens (colour, type, layout, shape)
  icons.tsx               345  29 maneuver kinds + system icons, hand-drawn SVG
  geo.ts                  272  polyline codec, haversine, formatting, snapping,
                               + snapAlong (metres along a line) and vertexAt
  styles.css             1362  layout, insets, responsive rules

  osm/
    engine.worker.ts     1140  parse (whole + streaming) -> graph -> index -> gazetteer, + A*
    pbf.ts                606  .osm.pbf protobuf reader
    merge.ts              318  union-find merge of adjacent extracts
    mergeguard.ts         170  can a merge be afforded here? three outcomes
    regions.ts            444  RegionLibrary, catalogue, bbox helpers, merge cache
    engine.ts             335  worker client, format sniff, GeoJSON mirroring
    tags.ts                36  shared node-tag filter

  nav/
    valhalla.ts           314  Valhalla /route client
    providers.ts          345  provider chain, attempt trace, connectivity
    engines.ts            239  engine selection, readiness, provenance
    geocode.ts            231  Nominatim client, 1 req/s throttle
    traffic.ts            163  fastest-of-N-alternates traffic verdict
    location.ts           212  device/browser/simulated location
    offroute.ts           114  deviation detection primitives, reroute origin
    reroute.ts            346  reroute policy: when to act, backoff, banner
    progress.ts           126  ETA policy: monotone, never zero, keep last good
    maneuver.ts            85  Valhalla maneuver codes -> icons

  map/
    MapView.tsx           330  MapLibre view, tile/offline style switch
    style.ts              520  Google palette, tile remap, offline LOD style

  regions/
    RegionsScreen.tsx     548  manage, catalogue, cross-region route test
    store.ts              265  RegionLibrary singleton, per-region workers
    persist.ts            615  IndexedDB caching of parsed datasets
    download.ts          1317  streaming downloader

test/            792 unit tests, 36 files
test/e2e.mjs           44 browser checks, built bundle
test/screens.mjs        53 checks x 3 viewports (159 total)
tools/osm2pbf.mjs        XML -> PBF encoder (builds the test fixtures;
                            extract slicing is done by osmium on a desktop)
tools/serve.mjs         LAN static server for on-device manual testing
tools/diag-route.mjs    throwaway used to read a failing e2e check (§3.19)
```

`App.tsx` at 2873 lines is the largest file in the project and is now the main obstacle to
working on it: the guidance model, the routing orchestration, the reroute effect and every
screen live in one component, so a change to any of them risks all of them, and the failure
mode is a render-time throw that only a browser suite can see (§3.19). Splitting the
screens and the guidance model out is the obvious next structural step, and it is listed
now precisely so that it is not rediscovered as if it were new.

---

## 7. Known gaps

Ordered by how much they matter.

1. **Never run on physical hardware.** Everything is browser-verified plus one
   Android 14 emulator. WebView behaviour, real GPS quality, SAF file import and
   on-phone memory pressure are unproven. The one gap no amount of further work
   here can close — it needs a phone. *(Was gap 2; renumbered, and the old gap 1
   is closed — see below.)*
2. **A real province has never been parsed on device.** Streaming (§3.12) is
   verified for equivalence and against a 19-way fixture; peak memory on an
   actual 100–900 MB extract is unmeasured. Streaming removes the ~2× file-size
   spike but does not prove the parse fits a phone. This also bounds the merge:
   the guard in §3.18 estimates from declared graph size and refuses rather than
   guessing, but a refusal on a real province has never been seen.
3. **The offline LOD refreshes on zoom, but is unverified at province scale.**
   There was no `zoomend` listener at all, so the level of detail only changed as
   a side effect of a GPS fix and at a standstill the map visibly refused to gain
   detail — fixed in §11. What is still unverified is the other half: §3.13's
   assertions are structural (every line layer has a floor below zoom 10,
   arterials branch on class at low zoom), and the only extract available offline
   is the tiny fixture, which cannot show what a province looks like at zoom 6.
   See that section for why the claims are worded the way they are.
4. **SAF file import untested on device.** The picker UI was not automatable over
   adb; browser-tested only. Re-confirmed while building the engine screen: the
   file picker cannot be driven through `adb shell input`, so device runs start
   with no map loaded and the offline engine correctly reports
   "No offline map loaded".
5. **Reroute is wired but its failure path is thin.** The app now reroutes on its
   own (§3.11), and the browser suite drives the full off-route flow. Not yet
   exercised: a reroute that fails *while offline* (the local engine cannot reach
   the pair), or two consecutive failures driving the backoff to its cap on device.
6. **Offline turn-by-turn infers turns** from bearing changes. Real instructions
   need Valhalla. Measured against Valhalla on one 4 km stretch it missed three of
   seven real maneuvers, invented one and reversed one direction — so the app now
   *labels* inferred guidance as inferred (§10.5). The inference itself is still
   wrong often enough that it should not be relied on for navigation.
7. **zstd PBF blobs are rejected by name.** Geofabrik still ships zlib, so this
   is future-proofing only.
8. **Emulator cutout band.** A black band remains where the emulator simulates a
   display cutout. Believed cosmetic and device-specific; not confirmed.
9. **Optional: NDK cross-compile Valhalla** to replace the local engine with real
   turn-by-turn. Gaps 6 and 9 share one dependency, and §5.3's objection is
   external rather than about effort: arm64 sysroot builds of boost, luajit,
   prime_server, GEOS and zlib either exist or they do not. Worth a bounded
   feasibility spike before committing anything.
10. **Chrome still covers ~98% of the viewport** at phone portrait, and ~142% of
    its height in landscape. Every element is 76dp or larger because the design
    says so, and none of them is in the wrong place — but a driver looking at this
    sees very little map. The first thing a designer would cut, and the one change
    that should not be made without one.
11. **A tile-host failure substitutes the map style silently.** If the remote style
    cannot be fetched the offline style is used instead, which is the correct
    degradation, but nothing on screen says the basemap changed source. MapLibre
    also logs its own validation exceptions for the offline style. Harmless to the
    user, noisy in a logcat.
12. **`RoadGraph.regionOf` is persisted for every region** despite only being
    meaningful for merged graphs (§3.5.2). Reachable now that the app can build a
    merged graph, but the bytes are still wasted on single-region entries.

### Closed in the §3.17–3.19 pass

| Was gap | Now |
|---|---|
| Cross-region routing stitched at a bounding-box midpoint and produced a wrong route (§7 gap 1, the "most serious open gap") | One A\* over a merged graph, cached, behind a memory guard that refuses with a reason. §3.18, §3.5.2 |
| `merge.ts` was 318 lines of dead code plus ~800 lines of unreachable tests | Called by `RegionLibrary.route()`; requirement #10 implemented |
| The ETA could read `0 m` while route remained, and increase while driving forwards (§7 gap 12, "the most dangerous readout in the app") | Three properties as pure policy, asserted as properties. §3.17 |
| A `useMemo` closing over a later-declared ref broke the whole app with all 747 unit tests green | `test/tdz.spec.ts` and `test/app-render.spec.ts`. §3.19 |

### Closed by the third pass (§11)

| Was | Now |
|---|---|
| A letter could not be typed anywhere: the `m` mute shortcut sat above the typing guard with an unconditional `preventDefault` | The guard is first. §11, `test/focus.mjs` |
| Focus was destroyed on every screen change, so the next Tab restarted from the top of the document | A screen change announces itself, takes focus, and sets `document.title`. §11.1 |
| Every "unavailable — and here is why" sentence was inside a `disabled` button, so it could never be reached | `aria-disabled` throughout, with the activation refused. §11.2 |
| Arrival was never announced or spoken for any Valhalla route, because `next` is built with `?? active` and so was never null | Derived from progress. `test/audit-regressions.spec.ts` |
| The distance to the next turn was capped at 9999 m and the capped value was *spoken* | The true distance. §10 |
| Non-major turns were painted at display3 and spoken as nothing | Every instruction change is spoken and announced |
| Valhalla's own error text reached the driver in a red card | Translated to something actionable; the raw text kept in the trace |
| Home and Work routed to two fixed points in the English Channel | The driver's own saved destinations, unset until set |
| With no GPS the map opened on London while the app's position was Calgary — 7,000 km apart | One exported placeholder, and the map opens on it |
| The maneuver arrow had no background for every non-major turn (declarations stranded between rules) | The declarations are inside the rule; the suite parses the stylesheet |
| The ETA bar sat under the system status bar and the nav bar in the gesture area (padding shorthand resetting an inset longhand) | One shorthand with the inset folded in |
| The launcher computed to one column at phone portrait — five 158dp tiles in an 886px scroll | Two columns, sized to fit |
| The app bar ellipsised to "Canopy …" and "Onl…" at 412px | The wordmark has a short form; the pill is sized by its content |
| A successful fallback route painted a warning in the red error card above Start | Warnings have their own tone, and a fallback is the expected path |
| The whole provincial road network was re-serialised to GeoJSON once a second | Cached per dataset and zoom |
| Overlays were applied from props frozen at the start of a style boot, so a route chosen in that window drew nothing | Read live from a ref |
| Zooming gained no new roads on the offline map | `zoomend` re-applies, and `prefers-reduced-motion` is honoured |
| Every settings *read* was unguarded, so a WebView whose `getItem` throws opened on the crash card | `safeGet` throughout |
| Region deletion discarded the reason it had built for itself; a refused write freed no bytes and said nothing | Awaited and reported |
| A 900 MB download outlived the Regions screen | Aborted on unmount |
| The catalogue availability probe fired every URL at once, with no deadline, under a comment claiming it was lazy | Four at a time, 10s each, cancelled on unmount |
| The focus ring measured 1.97:1 on the map | A three-layer sandwich that passes on both extremes |
| Progress was a firehose in a live region, or absent entirely on Regions | The number is the progressbar's value; the region carries the stage |
| `<main>` did not exist and three screens had no heading | `<main>`, a heading per screen, `aria-modal` on both dialogs |

### Closed by the audit pass (§10)

These were all live gaps or missing capabilities before §10, and are recorded here
so the list above is not read as the whole story:

| Was | Now |
|---|---|
| Offline did not survive a reload — the browser served its own disconnected page | Service worker precaches the shell; verified by reloading with the network off || Mute controlled no audio at all | Real spoken guidance via the Web Speech API; disabled-with-a-reason where no engine exists |
| No map attribution was displayed — an ODbL breach | Credit declared on the map sources and rendered; regression-guarded in `test/attribution.spec.ts` |
| The parser accepted `lat="-200"` and invented 74,756 addresses | Coordinates bounded in both readers; bounding box no longer reports its sentinel |
| A corrupt/empty/road-free `.osm` silently replaced a working map | Refused with a specific message; the map is left untouched |
| No settings survived a reload — 0 of 5 | All persist, validated on read, with quota failures reported |
| An engine labelled "Unavailable" was fully selectable | Inert, with the reason in the row |
| No focus ring anywhere in the app (UA default, 1.06:1) | A ring that survives both the dark chrome and the light map canvas |
| The import file picker was unreachable by keyboard | A real button driving a visually-hidden input |
| `m` (documented as mute) opened the search screen; Escape ended an active trip | Named keys matched first; Escape unwinds one level and never ends a trip |
| The online geocoder was 100% dead — its host did not resolve | Fixed, and the readiness reason now names the real cause |
| `geocode.ts` had no request timeout | 12 s, composed with caller aborts; verified against a hanging host |
| The off-route banner printed `6978332 m off the route` | Says what the driver acts on; the rejoin distance is formatted in their units |

Closed since the last release (v0.11.1): app bar / grid cell are now tokens
(§3.14), the test server is in the repo (§3.14), reroute is wired (§3.11), the XML
parse streams (§3.12), the offline LOD fix (§3.13), the corrupt `.nav-panel` rule
and the screen-coverage regression that hid three layout bugs (§4.6, §9), and the
three cold-start console warnings (§3.15).

---

## 8. Commands and workflows

```bash
npm install
npm run dev          # vite dev server
npm test             # 702 unit tests
npm run e2e          # 39 browser checks against the built bundle
npm run build        # typecheck + production build
npm run preview      # serve the built bundle
npm run sync         # build, clear android assets, cap sync
npm run apk          # sync + gradlew assembleDebug
npm run typecheck
npm run screens      # screen coverage at 3 viewports
npm run serve        # LAN server for on-device testing (see below)
```

**JDK 21 is required.** Gradle 8.11 cannot run on Java 25
(`Unsupported class file major version 69`). `npm run apk` defaults `JAVA_HOME`
to JDK 21.

### Releasing

```bash
npm test && npm run e2e && npm run screens
git commit -am "..." && git tag -a v0.11.4 -m "..." && git push origin main --tags
```

**Then read the CI run.** Per §3.16, that is the only thing that makes "CI runs
the full gate" true.

The Release workflow runs typecheck, unit tests and the build, then attaches the
APK; the browser suites run on CI for the same commit. **15 releases across 17
tags**, latest v0.11.2. `v0.7.0` and `v0.10.0` have tags whose Release runs
failed, and v0.11.2 needed one re-tag for the same reason (§9) — so a green tag is
not evidence of a green release, and the release list is the thing to read.

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

### Local state that does not survive a reboot

```bash
npx playwright install chromium     # build 1243 for playwright-core 1.63
```

The `canopy` AVD already exists (`~/.android/avd/canopy.avd`, Android 14 /
google_apis x86_64) and `/dev/kvm` is present, so a boot is ~15 min with `sg kvm
-c`. `test/fixture.osm` can be pushed to `/sdcard/Download/` but the SAF picker
still cannot be driven by `adb shell input` (gap 5), so device runs begin with no
map loaded.

---

## 9. The plan, and what happened to it

The work was planned in blocks and then spent across several sessions. This
section records it because **the record of the estimate is itself the useful
part**: the first plan was padded by roughly 5×, and correcting it changed which
gaps looked expensive. Several blocks were then added mid-flight by audits rather
than by planning, and those found more than the plan did.

### 9.1 The plan

| Block | Work | Closes | Outcome |
|---|---|---|---|
| 1 | Unblock the e2e gate (`playwright install chromium`) | — | **Done** |
| 2 | Engine selection + provenance visibility | req #2, #18 | **Done** (§3.6.1) |
| 3 | Wire rerouting into the navigation screen | req #18 | **Done** (§3.11) |
| 4 | Streaming parse | §7 gap 2 | **Done** (§3.12) |
| 5 | Emulator: exercise nav + reroute on device | §7 gap 1 | **Partly done** |
| 6 | Zoomed-out offline density as a style/LOD fix | §7 gap 3 | **Done** (§3.13) |
| 7 | Tag, read the CI result, update STATUS | req #16, #21 | **Done** — v0.11.2 and v0.11.3 released, both workflows green |
| 8 | *Added by audit:* dead-code + STATUS reviews | — | §9.3 below |
| 9 | *Added by audit:* reroute failure paths, frozen-position loop | — | §3.11.1 |
| 10 | *Added by audit:* PBF coordinate correctness | req #5 | §4.1 |
| 11 | ETA readout: monotone, and `0 m` means arrived | req #19, §7 gap 12 | **Done** (§3.17) |
| 12 | Wire cross-region merging, behind a memory guard | req #10, §7 gap 1 | **Done** (§3.18) |
| 13 | *Added by the crash of block 11:* gates for render-time failures | — | **Done** (§3.19) |

Blocks 8–10 were not planned. They came from asking what was still broken rather
than what was still missing, and they found the single most consequential bug in
the project (§4.1) plus a live reroute loop that had been shipping.

### 9.2 Release and CI

Block 7 is the one that only completes if someone looks at the result, and looking
caught a failure every time: the first Release run died in the test step, and two
later pushes failed because a spec read a fixture that was never committed and
then wrote scratch to a machine-local path.

That is four times in this project's history that a "green" local story turned
out to be wrong — §3.16's seven red pushes, §4.6's screen-coverage regression, and
these two CI failures. Every one was caught by reading the run output rather than
trusting the summary, and the last two only appeared *because* the work was
pushed. Verifying against a clean export of the git index, from a different
working directory, is now the habit rather than running the suite in place.

The "Closes" column now names §7 gaps as they are numbered *in this revision*.
The gap list was renumbered twice, and earlier versions of this table pointed at
the wrong numbers — which is the same class of error as the counts in §2: a
cross-reference written once and never re-checked after something beneath it moved.

### 9.3 What the audits found

Blocks 1–7 were complete, so the remaining budget went to asking what was still
*wrong* rather than what was still missing. Eight subagents were run in parallel
against non-overlapping ground — one returned nothing at all, which is itself worth
noting, since a subagent that fails silently is indistinguishable from one that
found nothing until you read its report. The ones that returned findings found
things I would not have gone looking for:

- A **dead-code audit** found the `.nav-panel` corruption and, more importantly,
  that `src/osm/merge.ts` — 318 lines plus ~800 lines of tests — is unreachable
  from the app. That makes requirement #10 false, which corrects §1 and §3.5.2
  and is now §7 gap 1.
- A **launch-warning investigation** traced the three cold-start console warnings
  to three layers of the upstream tile style (§3.15), and closed a gap that had
  been recorded as merely "untraced".
- A **STATUS.md audit** checked the document against the code and found that its
  own correction note was wrong about the e2e count, that the screen-coverage
  figure was unreachable, that §3.15 was referenced but never existed, that three
  §6 line counts were stale, that §1 row 12 overstated the provider count, and
  that §3.3's "asserted against a hand-computed bound" described an assertion
  that does not exist. All corrected here.
- A **dead-affordance audit** found four controls declared, wired to real work and
  never invoked — including no way to clear a route, and map taps that were a
  guaranteed no-op (§4.6) — and established that the whole navigation control
  stack had **zero** browser coverage, which is why the `.nav-panel` regression
  shipped (§4.7).
- A **reroute test pass** found that a frozen GPS fix rerouted every 30 s forever,
  measured at 20 requests in ten minutes, and that a failure reason was erased
  after one second (§3.11.1).
- A **cross-region investigation**, asked only to quantify how wrong stitching is,
  reported the PBF coordinate bug on its way past (§4.1). Worth noting the
  investigation was authorised as documentation-only and the fix was not: the
  measurement turned out to matter more than the thing it was measuring.

The screen-coverage regression (§4.6) was self-inflicted, and it is the most
useful thing in this section: I added a screen to the suite, broke the unwind with
`goBack()`, and the suite kept reporting "all checks passed" over a third of its
scope for the rest of the session. Had the audit not independently re-derived the
expected check count, it would still be broken.

### 9.4 Estimates, corrected twice

The original plan budgeted 30 minutes for `npx playwright install chromium` (a
one-line download), 45 minutes to replace 10 CSS literals, and 15 minutes to boot
an emulator that was **already running**. Two substantive corrections came out of
checking rather than assuming:

- **The offline map is an afternoon, not a quarter.** I had filed it as a
  weeks-long MBTiles pipeline. `MapView.tsx:174-176` already mirrors the parsed
  geometry into MapLibre `GeoJSONSource`s, so the data was never missing and only
  the level-of-detail was wrong.
- **The emulator was available all along.** I had written off the whole device
  axis on the grounds that there is no phone. `/dev/kvm` and a booted AVD were
  sitting there. The device gap narrowed to *physical* hardware only.

### 9.5 What actually happened

**Session one: 38 minutes of wall clock**, covering blocks 1, 2, half of 5, and
the STATUS half of 7. Then work stopped.

The stop was my error and worth recording plainly: after finishing a coherent
unit of work I ended the turn by *asking whether to continue*, when the plan had
already specified reroute as the next block and the instruction had been to work.
That cost roughly nine idle hours against a six-hour budget. The lesson is
narrower than "ask less": when a plan names the next step and the next step is
not destructive or ambiguous, continuing is not a decision that needs sign-off.

**Session two** picked up block 3 and did not stop: rerouting, streaming parse,
the LOD fix, the two owed requirement items, and the duplicate system-bar
handling. Unit tests went 380 → 516, e2e checks 23 → 39.

**Session three** did the audit work described above, and a fourth pass followed
it: unit tests 527 → 599, screen checks 42 → 150, and the two document
corrections above.

What the fourth pass found is the most important result in this record. A subagent
asked to quantify cross-region routing reported, alongside its measurements, that
`src/osm/pbf.ts` divides coordinates by 1e-9 where the spec says 1e-7 — so every
real `.osm.pbf` extract was being read 100× too small, putting Andorra at 0.42 N.
The parser and the fixture encoder shared the wrong constant, so the round trip
agreed with itself and the whole suite was green. I verified it before acting, and
it is worse than it looks: it also means most of gap 1 was theoretical until the
fix, because there was no correctly-parsed province on the device to stitch
between. Fixed in §4.1.

The generalisable lesson, and the reason it is written down at length: **a
self-consistent round trip cannot detect a mistake both halves share.** Two
audits in a row found bugs that every passing test was structurally unable to
see — this one and the `.nav-panel` corruption — and both were found by asking
"what is *specification* here, and is it written down anywhere?" rather than by
running the suite again.

Two process notes, because both cost real time:

- A restarted server killed the emulator mid-session and a verification run was
  lost, which briefly looked like a regression in the streaming import. It was
  not — re-running against a fresh preview server cleared it. **A failed check
  after an interruption is a hypothesis, not a finding.**
- One subagent's cleanup used a `pkill` pattern broad enough to take down a
  preview server another process was using. The same class of problem as §4.6: a
  tool acting outside the scope it was given, and no error raised.
### 9.6 Owed, and then done

Requirement #2's app-bar/grid-cell tokens (~15 min) and requirement #20's
`serve.mjs` living in `/tmp` (~20 min) were identified but never scheduled. Both
were dropped by stopping early rather than by a decision to skip them. **Both are
now done** — see §3.14.

### 9.7 Carried forward

**Session four** closed the two gaps this document had called most serious, in the
order the gaps were ranked rather than the order they were convenient.

**The ETA readout (§3.17) first**, because it was the most dangerous *readout* in
the app and it was bounded. The root cause turned out to be that the ETA re-projected
every fix from scratch while `progressAlong` was already monotonic — the two halves
disagreed, and only one of them had been thought about. Fixing it needed a new
primitive (`snapAlong`, in metres) before it needed any new policy, because a segment
index cannot express arrival at all.

**Cross-region merging (§3.18) second**, and it was the larger of the two by some
distance. The merge itself needed nothing: `merge.ts` was already correct and already
tested, and the entire gap was that nothing called it. All the work was in the four
surrounding decisions — where the merged graph lives, whether to attempt it, what to do
when it cannot be afforded, and what to tell the driver when it is refused. The last of
those is the one worth keeping: `route()` returns `null` for three unrelated reasons and
the caller cannot tell them apart, so "this device cannot compute this route" was
indistinguishable from "no route exists", which is how a reachable destination becomes an
unreachable one.

**Then a mistake, and the gates that came out of it.** The ETA fix declared `routePos`
below the two memos that read it. A `useMemo` callback runs during render, so that is a
temporal dead zone, and it threw on every screen. All 747 unit tests passed. The app
rendered the error boundary's recovery card and nothing reported a crash — the boundary
working correctly is what made it quiet. Only `test/e2e.mjs` caught it.

The process note is the same one as §9.2's and §4.6's, and it is now the fifth
occurrence: **a green result nobody re-derived is not a green result.** What is new is the
corollary, which cost the most to learn: *a suite that has never been seen to fail has not
been tested.* The e2e suite had a real bug in it for a whole session and the fix was to
read the failing check's actual page text rather than reason about the code, which is why
`tools/diag-route.mjs` exists. The first attempt to close the gap — a render smoke test —
turned out **not** to catch it, because both guidance memos return early on a first render
and the bug needs a route to exist. Shipping it as if it closed the gap would have been
the same mistake in a new place, so it is documented as buying something smaller, and the
static ordering check that does catch it is in `test/tdz.spec.ts`.

Two things that came out of writing those tests are worth more than the tests. The
ordering scan immediately reported a *second* instance of the same hazard —
`beginRouteProgress` read a hundred lines above its declaration, harmless only because it
runs on a click — and it was moved anyway, because a permanent documented exception to a
rule is how the original bug happened. And the first draft of the noise fixture in
`test/progress.spec.ts` passed with the monotonic clamp deleted: ±2 m of GPS noise cannot
flip an 11 m gap, so the test was decorative. Both are recorded because the temptation to
ship a green test that proves nothing is the strongest one in this project, and it has now
been resisted four separate times.

**Counts, re-derived rather than remembered:** 702 → 792 unit tests across 30 → 36 files;
e2e 44; screens 53 × 3 = 159; total JS 410.4 → 412.3 kB gzip. Thirteen line counts in §6
were stale and are now `wc -l` output. Note the direction of that last one: §2 carried the
correct screen figure (153) while §6 and §9.2 carried 150, so the error was not always a
number that was too large — which is the least useful thing to know about a class of
error, and the reason "just re-run it" is the only reliable instruction.

**Cross-region routing is no longer the most serious open item.** §7 has been
renumbered, and the old gap 1 is closed. What remains at the top is gap 1: never run on
physical hardware, which needs a phone and no amount of further work here.

### 9.8 Carried forward

**v0.11.2 is released**: 15 commits, CI green, Release green, APK attached. The
first Release run failed — 511 tests passed and then vitest died with
`process.exit unexpectedly called with "1"`, because `tools/serve.mjs` ran a
`process.exit(1)` start-up check *on import* and CI runs the tests before the
build. Fixed, with a regression test that reproduces the CI condition; the
original version of that test passed with the guard deliberately removed, because
`dist/` exists locally. Verified by breaking the guard again.

### 9.9 Serving for manual testing

```bash
npm run build && npm run apk    # dist/ and the debug APK
npm run serve                   # 0.0.0.0:8080, prints the LAN URL
```

Serves `dist/` with the APK at `/dl/canopy-nav.apk`. It lives in the repo
(`tools/serve.mjs`) rather than in `/tmp`, where a cleanup silently killed the
manual-testing setup. The scripts this replaces:

```bash
npm run screens                  # screen coverage at 3 viewports
```

---

## 10. The audit pass

Ten browser audits were run in parallel, each owning one area of the app and
instructed to drive the **built bundle** in Chromium and report on UI, UX,
performance and anything that did not behave as intended. All ten reports are in
`/tmp/opencode/audits/`. What follows is what they found, what was done about it,
and — more usefully — what they found that is still not fixed.

The headline is that **auditing found four defects where the app claimed a
capability it did not have.** Those are worse than a crash, because a crash is
visible and a claim is believed.

### 10.1 Claims that were false

**The offline promise did not survive a reload.** The app's central claim is
that it works with no network, and that was true right up until you reloaded the
page: with no network the browser never reached the app at all and served its own
`ERR_INTERNET_DISCONNECTED` page. Nothing had cached the bundle, because the app
lives at a real origin. In a car that is the *common* case — a driver opening the
app in a tunnel before the WebView has ever cached it — and there was no way
forward from that screen.

There is now a service worker (`src/sw.ts`), built as its own Vite entry,
precaching the shell. Getting it to work took four attempts, and each failure
looked like success, which is the only reason they are written down:

| Attempt | What happened | Why it failed |
|---|---|---|
| 1 | `sw-<hash>.ts` emitted | `new URL('./sw.ts', …)` makes Vite treat the worker as a *static asset*; the output was untranspiled TypeScript, which no browser can execute |
| 2 | Cache held `index.html` and nothing else | JS and CSS filenames are content-hashed, so offline every module script 404'd |
| 3 | `ERR_FAILED` on the entry script, with the bytes sitting in the cache | `cache.match(req)` honours `Vary`, and module scripts are requested with `crossorigin` |
| 4 | Favicon still failed | `public/` assets never appear in the bundle |

Verified by reloading under `setOffline(true)`: the app renders, all five
launcher tiles are present, the map is sized to the viewport, zero console
errors.

**The Mute button muted nothing.** An exhaustive search of `src/` and the Android
assets for `AudioContext`, `new Audio`, `speechSynthesis`, `vibrate` and any
bundled audio returned zero functional hits. The control toggled a boolean whose
only consumers were its own icon and its own label.

That is the most damaging shape a defect can take here: a driver taps Mute, hears
nothing change, and concludes voice prompts are off — a wrong conclusion that
*looks* like the safe one. `src/nav/voice.ts` now drives real spoken guidance
through the Web Speech API, announcing a step once per *meaning* change rather
than on every position tick, and interrupting itself for a new maneuver so an
instruction is never queued behind a stale one. Where the WebView has no speech
engine the control stays visible but disabled with the reason in its accessible
name — a missing control reads as a missing feature, a disabled one explains
itself.

**The parser invented 74,756 places.** `+a.lat` is `NaN` for a missing attribute,
and the node was stored regardless. A malformed extract carrying `lat="-200"`
produced a gazetteer full of invented addresses — "Neg 1200", "Neg 12300" —
presented in search results as `address / Offline`. Coordinates are now bounded in
both readers. The bounding box also no longer reports its uninitialised sentinel
as `180.000, 90.000, -180.000, -90.000` when nothing was parsed.

**No map attribution was displayed at all.** `attributionControl: false` at
construction plus `.maplibregl-ctrl-attrib { display: none }` meant the app showed
no credit anywhere, in either map mode, while every road, label and POI it draws
is OpenStreetMap data. That is a breach of the ODbL, not a cosmetic bug. The
credit is now declared on the map sources and rendered by the library's own
control.

### 10.2 The audit found a regression this project introduced

The bundle split (§10.4) put MapLibre's stylesheet in a separate lazily-loaded
chunk, so it arrived *after* the entry CSS. `.maplibregl-map { position: relative }`
and `.map { position: absolute; inset: 0 }` tie on specificity, so which won came
down to stylesheet order — and the map's always won. **The map rendered nothing
at all**: the container collapsed to 0px and the canvas fell back to 412×300.

It passed the e2e suite, because that suite asserts horizontal overflow and text
visibility, not that a map drew anything. It was caught by an audit that
screenshotted and counted pixels. The fix sizes a wrapper the library has no
opinion about, rather than raising specificity — which would work today and break
silently the next time MapLibre adds a class.

Worth recording as a process point: **the existing gates could not see it.** A new
check now asserts the map container and canvas fill the viewport and that tiles
were actually fetched.

### 10.3 What is now enforced rather than written down

| Gate | Command | Enforces |
|---|---|---|
| Lint | `npm run lint` | Type-aware rules; ratcheted at 27 warnings, so growth must be deliberate |
| Bundle budget | `npm run bundle` | Entry 130 kB, initial 150 kB, largest chunk 300 kB, total JS 460 kB (gzip) |
| Attribution | `test/attribution.spec.ts` | The ODbL credit is present, well-formed, and not re-suppressed |
| Import safety | `test/import.spec.ts` | A bad file is refused and never replaces a working map |
| Settings | `test/settings.spec.ts` | Every setting round-trips; a malformed endpoint is not "Ready" |
| XML safety | `test/xmlentities.spec.ts` | Entity expansion is structurally impossible; hostile documents terminate |
| Crash safety | `test/errorboundary.spec.ts` | A render throw shows a recovery card rather than a blank screen |

The bundle budget and the lint ratchet are both *ratchets*: raising a number is a
deliberate edit to a file, not drift. That is the same reasoning as the screen
suite in §9 — a green result nobody re-derives is not a green result.

### 10.4 Sizes

| | Before | After |
|---|---|---|
| Entry JS (gzip) | 398.8 kB | **105.7 kB** (−74%) |
| Entry CSS (gzip) | 13.1 kB, render-blocking | **4.4 kB**, deferred with the map |
| Largest chunk | — | 281.6 kB (MapLibre), loaded on first paint |
| Unit tests | 599 | **702** |

MapLibre and the region manager are `React.lazy`. Neither is needed to render the
first frame, and the entry chunk is parsed on a phone's main thread before
anything is interactive.

### 10.5 Everything the audits changed, and everything they left

The audits produced 8 written reports (two of ten agents timed out; both were
relaunched) covering ~250 browser scenarios. Below is the complete accounting, so
that §7 can be read as a summary rather than the whole record.

#### Fixed — the app claimed something it did not do

| # | Defect | Evidence it is gone |
|---|---|---|
| 1 | Offline did not survive a reload; the browser served its own disconnected page | Reload under `setOffline(true)`: app renders, 5 tiles, map sized, 0 console errors |
| 2 | Mute muted nothing — no audio subsystem existed anywhere | `src/nav/voice.ts`; control is disabled-with-a-reason where no engine exists |
| 3 | No map attribution displayed anywhere — an ODbL breach | Rendered and asserted by `test/attribution.spec.ts` |
| 4 | The parser invented 74,756 addresses from `lat="-200"` | Coordinates bounded in both readers |
| 5 | The bounding box reported its uninitialised sentinel as data | Degenerate-but-true box when nothing parsed |
| 6 | `m` (mute) opened search; Escape ended an active trip | Verified in-browser: mute toggles, navigation survives Escape |
| 7 | An "Unavailable" engine was fully selectable | `disabled`, with the reason in the row |
| 8 | Nothing persisted — 0 of 5 settings survived a reload | Units verified surviving a reload in-browser |
| 9 | The online geocoder's host did not resolve at all | `.org` verified answering 200; `.de` confirmed NXDOMAIN |
| 10 | `geocode.ts` had no timeout — "Searching…" forever | Verified against a host that never answers |
| 11 | `6978332 m off the route` — unformatted, always metric | Qualitative wording; rejoin distance formatted in the user's units |
| 12 | The ETA bar pushed Exit off-screen (x=506 in 412px) | No overflow at any of the three viewports |
| 13 | The control column sat 137.7px left of its own `right` offset, on the banner | Absolutely-positioned the widest child; measured clear |
| 14 | The off-route notice painted over the maneuver instruction | One top-down flow: bar, notice, card, controls |

#### Fixed — a regression this project introduced

Splitting the bundle put MapLibre's stylesheet in a lazy chunk, so it loaded
after the entry CSS; `.maplibregl-map { position: relative }` tied on
specificity and won on order. **The map rendered nothing.** 39 e2e and 150 screen
checks passed throughout. Fixed by sizing a wrapper the library has no opinion
about; the e2e suite now asserts the map draws, and was verified to fail when the
map is deliberately collapsed.

#### Fixed — correctness and safety

- A corrupt, empty, truncated, non-OSM or road-free `.osm` silently replaced a
  working map. Now refused, with the map untouched.
- The format sniff let the extension overrule the bytes, so a PBF named `.osm`
  imported as an empty region.
- `OsmEngine`'s constructor sat outside the try block, so its failure escaped
  `importRegionFile` and the catch then double-faulted, replacing a real diagnosis
  with "Cannot read properties of undefined".
- The availability probe never cancelled its one-byte ranged GET — a 16× over-fetch.
- Quota failures silently lost an imported region on the next launch.
- `MapView`'s `cancelled` flag was dead code, racing two style boots.
- The long-press timer outlived the component.
- Numeric XML character references used `fromCharCode` (UTF-16 code units), so
  `&#128512;` rendered as a private-use glyph instead of an emoji.
- A NUL byte had got into `engine.ts`, making the file binary to every text tool.

#### Fixed — accessibility

No focus ring existed anywhere in the app (UA default, 1.06:1 measured); the
import picker was unreachable by keyboard; `user-scalable=no` failed WCAG 1.4.4;
`prefers-reduced-motion` was unhandled; there were no landmarks or headings; the
arrival event was never announced; error text was 16px with no dismiss and no
role; the steps screen told a user who had imported a map to import a map.

#### Still open — not fixed, listed so it is not lost

1. **Inferred turn-by-turn is unreliable, and now says so.** Against Valhalla on
   one 4 km stretch it missed three of seven real maneuvers, invented one,
   reversed one, and the step *count* varied with polyline tessellation density
   rather than with the road. The steps screen labels inferred guidance as
   inferred; the inference itself is unchanged. Needs real maneuver data — §7 gap 6.
2. **A tile-host failure substitutes the style silently** (§7 gap 11).
3. **Chrome covers ~98% of the viewport** at phone portrait (§7 gap 10).
4. **Nothing has run on physical hardware** (§7 gap 1). No further work here
   closes it.

**Closed since this section was written.** The two entries this list used to carry at
the top — the ETA reading `0 m` while route remained, and cross-region routing being
wrong — are both fixed, in §3.17 and §3.18. They were left in place in the list above
only long enough to be renumbered against the new §7; the substance is in §7's
"Closed in the §3.17–3.19 pass" table.

#### Two things a second opinion would help with

- The 20 s routing and 12 s geocoding timeouts are reasoned, not measured against
  real latency tails.
- The narrow-screen navigation layout uses `:has()`. It is supported in current
  Chromium and Safari; on an older Android WebView the layout falls back to
  overlapping elements rather than breaking.

---

### 10.6 Commands added

```bash
npm run lint      # type-aware ESLint, ratcheted at 27 warnings
npm run bundle    # gzip size budget on the built output; fails on regression
npm run check     # typecheck + lint + unit tests
```

---

## 11. The third pass: what a driver actually gets

§10 audited the *code*. This one drove the built app in Chromium at three
viewports, read it, and compared it against Google's published automotive
specifications. It found that the things this app is *for* were the things a
keyboard or screen-reader user could not reach.

### 11.1 One root cause behind most of it

There was exactly one `focus()` call in the whole app, and it targeted the search
field. Every other transition swapped React state, which unmounts the control
that was just activated, so focus fell to `<body>` and the next Tab restarted
from the top of the document — on the Regions screen, roughly sixty catalogue
rows. Because a bare letter also opened search, pressing `s` after tapping
Settings both lost your place and navigated away.

That is not a keyboard-user problem alone. On a head unit driven by a rotary
controller or a switch, losing focus is losing the app.

Screens now announce themselves, take focus, and set `document.title` — which was
the static string "Canopy Nav" for the life of the process, so nine screens were
nine identical entries in a task switcher. Search and the route preview had no
heading at all, so heading navigation skipped them.

**The rule is "the heading is the fallback", not "the heading wins".** The first
version focused it unconditionally, which is right for Settings, Engines, Regions
and the turn list and wrong for Search — arriving there put the caret on a
visually hidden heading, and typing did nothing. A screen that claims focus
during its own commit keeps it.

### 11.2 Every reason a control was unusable, was unreachable

`disabled` removes a control from the tab order. Every sentence in the app
written to explain *why* something cannot be used — "Unavailable — no offline map
loaded", "This download URL could not be reached", "Voice guidance unavailable on
this device" — lived inside a `disabled` button. The Engines screen read as
"here are some engines, pick one", with the chosen one impossible to explore.

All of them are `aria-disabled` now, with the activation refused. The e2e check
asserted the old behaviour, so it was rewritten to assert the property that was
actually wanted: the row stays focusable *and* carries its reason.

### 11.3 The navigation announcements were never heard

`NavOverlay` mounts only while navigating, so its live region was created *with*
"In 240 m, turn right" already inside it. NVDA, JAWS and TalkBack all commonly
discard content inserted into a live region in the same commit that creates the
region — so the first instruction of every trip, the one needed to leave the
parking lot, was never announced. It only worked from the second maneuver.

It was also unthrottled: the region carried an **unbucketed** distance inside
`aria-atomic="true"`, while a comment three lines above claimed the distance was
deliberately excluded for exactly that reason. A driver using assistive
technology got "In 340 metres, turn right. In 330 metres, turn right." queued
without end, and because the queue never drained, the next maneuver arrived late
or not at all.

The distance stays — a turn instruction without one is not an instruction — and
is bucketed to the same 50 m step the speech path already used.

Progress updates had the mirror-image problem: the parser emits per segment and
the downloader per stream chunk, so the live text was "1%. 2%. 2%…" for the
minutes an import takes. The number is now the `progressbar`'s value; the region
carries only the stage. The two Regions cards had no role at all.

### 11.4 Measured against the published numbers

The design system claims a 4.5:1 floor and a 24dp minimum type size. Measured:

| Element | Was | Against |
|---|---|---|
| Focus ring, on the map | **1.97:1** | SC 1.4.11 wants 3:1 |
| "Not set" on an unset launcher tile | **2.87:1** | 4.5:1 |
| "Not set" on a solid tile | 4.49:1 | 4.5:1 — by one hundredth |
| Error card, over the transparent launcher panel | **3.39:1** | 4.5:1 |
| Offline chip, 18px over a blurred map | 4.34:1 | 4.5:1 (18px is not "large") |
| The hint's type size | 17px, 15px | 24dp minimum, 18px smallest step |

Three of those were not contrast problems but **dependency** problems: the tile,
the error card and the chip were translucent, so their ratios moved with whatever
was behind them — a road, or nothing. All three are opaque now, which makes the
ratio a property of the design system rather than of the screen.

The focus ring is a different shape of problem: **no single colour passes on
near-black and near-white**. So it is now a three-layer sandwich — dark, light,
dark — where each band is judged against whichever surface it is adjacent to. A
single ring would have worked today and failed silently the next time a control
moved.

The attribution was 11px — half the design system's smallest step — at a
~13×16px tap target, and the pinned progress card painted over it for the whole
duration of every download. The ODbL requires it displayed.

### 11.5 Two things this pass broke, and how they were caught

Recorded because both are the same shape as §3.19 and §4.6.

**Hiding the app bar's summary line below 600px took the map state with it.** The
line said "12,481 routable ways · 2 regions"; it was also the launcher's only
statement of whether a map existed, so at phone width a loaded province and an
empty app looked identical. Worse than the truncated label it replaced.

`test/screens.mjs` caught it — by asserting `/\d+ routable ways/` against the
launcher's text. That check had been passing for the wrong reason: the feature it
guarded is fine, dropping a fixture onto a fresh launcher yields "19 routable
ways · 1 region". It went red the moment the string moved off screen, which is
the argument for having it.

**The same suite also had a 6-second sleep** where the parse runs in a Worker, so
it failed on the first viewport of a run and passed on the second. It polls now. A
fixed wait is a coin toss dressed as a test, and a flaky red gets ignored.

### 11.6 The harness had to be fixed before it could report anything

`tools/focus.mjs`'s first Tab check dispatched a synthetic `KeyboardEvent` from
the page. That does not move focus — the browser's own key handling implements
Tab — so the check reported success without having moved anything. A green result
from a test that could not have failed. This is the sixth instance of that shape
in this project and the fastest so far to catch, because the test was written
knowing about the previous five.

### 11.7 What the new gates are

```bash
npm run focus   # 13 keyboard and focus checks in a real browser
npm run shots   # every screen, 3 viewports, computed styles recorded
```

`shots.mjs` writes the *computed* style of named elements beside the image, so a
defect CSS error recovery silently discarded — which is how the maneuver arrow
lost its background for every non-major turn — appears as a recorded value rather
than as an opinion about a picture. It also flags any text element whose content
is wider than its box, which is the commonest polish defect and the least visible
in a screenshot.

`test/audit-regressions.spec.ts` holds 25 source-level guards for the defects
above, each verified to fail when its defect is reintroduced. It strips comments
and string literals before matching, because several of these files quote the old
code in the note explaining the fix — a test that fails on a correct file trains
people to delete the explanation.

### 11.8 Still open from this pass

1. **No `main` landmark on the map itself.** It is the first tab stop on every
   screen and has no accessible name. Decorative `tabIndex={-1}` would remove the
   confusion; a composed description ("Route to X. Traffic. Offline basemap")
   would make it useful.
2. **The turn list has no list semantics**, so a screen reader cannot report
   "item 3 of 24" — which is how a driver scans a turn list.
3. **The navigation screen cannot reflow.** `overflow: hidden` on `html`/`body`
   and `position: fixed` on `.app` mean nothing scrolls, and every part of that
   screen is absolutely positioned. At 200% text zoom the banner and the control
   stack overlap.
4. **Confirming a region removal loses focus**, because the Remove button is
   unmounted when the confirm state appears.

None of these blocks use. All four are recorded so they are not lost.

---

## Attribution

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Routing via [Valhalla](https://github.com/valhalla/valhalla) and geocoding via
[Nominatim](https://nominatim.org/), both OpenStreetMap projects. Base tiles from
[OpenFreeMap](https://openfreemap.org/). Design specifications from Google's
*Design for Driving* documentation.
