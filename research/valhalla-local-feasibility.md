# Feasibility: running Valhalla locally instead of through the API

**Question.** Can Valhalla run *on the device* — replacing the TypeScript graph
engine (`src/osm/engine.worker.ts`'s unidirectional A*) with the same engine we
currently call over HTTP — and what does that cost in memory, disk and CPU?

**Answer.** Yes, and the resource picture is better than the current engine's —
with one caveat about *how* it is integrated. STATUS §5.3's objection (arm64
sysroot builds of boost, luajit, prime_server, GEOS…) applies only to one of
three integration routes, and is largely out of date for the other two. STATUS
§7 gap 9 asked for "a bounded feasibility spike before committing anything";
this document is that spike. All numbers below were measured in this study
unless marked *(published)*.

Date of measurements: 2026-11-08. Valhalla **3.9.1** (`pyvalhalla` manylinux
x86_64 wheel, the unmodified upstream binaries). Hardware: x86_64 laptop, 6
cores, 14 GB RAM. Phone figures are extrapolations and are labelled as such.

---

## 1. The three ways to run Valhalla locally

| Route | What runs on the device | STATUS §5.3 objection | Real cost |
|---|---|---|---|
| **A. WASM in a Web Worker** | Valhalla compiled to WebAssembly inside the existing WebView, in a worker exactly like `engine.worker.ts` | Does not apply — no NDK, no native deps. The `.wasm` is platform-neutral | ~7.4–10 MB added to the app *(published)*; engine memory bounded by config |
| **B. NDK library via a Capacitor plugin** | `libvalhalla` (tyr::actor) as a native `.so`, called over JNI | Partly applies | A library-only build needs **only boost headers, protobuf, zlib** — see §4.3 |
| **C. Bundled `valhalla_service` binary** | arm64 executable run from `nativeLibraryDir`, localhost HTTP (or one-shot mode per request) | Applies in full (prime_server/zmq) | Heaviest, hackiest packaging; but **zero UI/client changes** — `src/nav/valhalla.ts` already speaks this protocol |

There is now serious prior art for A and B that did not exist when §5.3 was
written:

- **`tobilg/valhalla-wasm`** (Sep 2026, MIT): Valhalla 3.8.3 → Emscripten,
  `valhalla-browser` npm package, runs in a dedicated Web Worker, lazy tile
  loading via HTTP ranges from an indexed tar, configurable WASM memory
  (128/512 MiB default in browsers, 1 GiB hard ceiling) and decoded-tile cache
  budget. Their own caveat: *"Physical mobile devices… not established."*
- **`ecc521/valhalla-wasm`** (Jun 2026, MIT): extracted from rivers.run, which
  uses it for **offline** navigation with no cell service. Ships prebuilt
  `valhalla.js` + `valhalla.wasm` (**7.4 MB**). Tiles are a lazily-mounted
  `.tar`; "a route uses **~20–50 MB** instead of the full multi-hundred-MB
  graph". Its storage seam is explicitly pluggable: *"the native filesystem
  (Capacitor/Electron), HTTP range requests, IndexedDB, or an in-memory
  buffer"* — i.e. it was designed for exactly this app's shape.
- **`valhalla` Rust crate and `@valhallajs/valhallajs` Node bindings**:
  in-process `Actor` API over `tyr::actor` — the same call shape route C or a
  JNI plugin would make. The Rust crate builds Valhalla from source with only
  `clang, cmake, libboost-dev, libprotobuf-dev, protobuf-compiler, zlib1g-dev`.
- The Valhalla README states Valhalla *"is also used on iOS and Android
  devices"*, and its tiled data structure was designed for *"on device routing
  capabilities on even the most meager of hardware"* (`concepts/why-tiles.md`).

---

## 2. What Valhalla is, resource-wise

Valhalla keeps the routing graph as **hierarchical tiles on disk** (3 levels:
4° highways, 1° arterials, 0.25° local; `concepts/tiles.md`), loaded **lazily**
by the tile reader and cached; only tiles a route touches are read. Searching
uses **bidirectional A\* with hierarchy transitions and shortcut edges**
(`thor/path-algorithm.md`), plus real costing (turn types, road class, ferry,
tolls…) at query time, and odin produces **real maneuvers and instructions** —
the thing Canopy currently infers badly (STATUS gap 6: 3 of 7 maneuvers missed).

That is the architectural difference that drives every number below: the
current engine materialises the whole graph in the WebView's JS heap
(`BYTES_PER_NODE = 96`, `BYTES_PER_EDGE = 24`, `src/osm/mergeguard.ts:48,75`);
Valhalla leaves it on disk and touches only the corridor.

---

## 3. Measurements: building tiles (the "import" step)

`valhalla_build_tiles 3.9.1`, Geofabrik extracts, 6 threads, no admin/timezone
databases (those are optional and only affect edge attributes), x86_64.

| Extract | `.osm.pbf` | Way-nodes | Graph nodes / edges | Build wall | Peak RSS | **Tiles on disk** | Tile files |
|---|---|---|---|---|---|---|---|
| Bremen (city) | 21.3 MB | 355,631 | – / 140,650 | **5.6 s** | 444 MB | **23.9 MB** | 8 |
| Schleswig-Holstein (province) | 159.3 MB | 3,118,589 | 777,978 / 973,281 | **26 s** (53 s at `-j 1`) | 1.59 GB (537 MB at `-j 1`) | **168.6 MB** | 290 |
| **Alberta (province)** | **352.2 MB** | 6,242,162 | 1,159,488 / 1,591,723 | **44.5 s** | 2.41 GB | **278.9 MB** | 1,438 |

Observations:

- **Tile disk ≈ 0.8–1.1× the compressed PBF** (0.79× Alberta, 1.06× SH,
  1.12× Bremen). Compare with what the app stores today: the extract itself
  plus an in-RAM graph. Tiles are a *disk* format; they never need to be
  resident.
- **Alberta is the headline.** This is the exact file the import guard
  deliberately refuses (STATUS §7 gap 13: "334 MB ≈ 58 M nodes ≈ 13 GB
  estimated"). Valhalla consumes it in **44.5 seconds** with a **2.4 GB**
  transient peak — and the 2.4 GB peak is a *build-machine* cost, not a
  runtime cost. If tiles are prebuilt (§6), the device never pays it.
- Build peak scales roughly linearly with input; single-threaded peak is much
  lower (537 MB for SH) because the parallel parse stages are what spike.
- `valhalla_build_extract` (or plain `tar`) packs the tile dir into one
  indexed `tiles.tar` of the same byte size; the tar form is what the lazy
  readers prefer (mmap in native, HTTP-range or file-backed in WASM).
- Published reference: the full *planet* builds on "quad-cores @ 2.70 GHz with
  16 gigs of RAM utilizing a SSD" in **~15 hours** (mjolnir docs) — a one-time
  CI job, not a device cost.

**On-device tile building** (only needed if packs must be built from the
downloaded PBF rather than shipped): SH single-thread was 53 s on x86; a phone
big core is roughly 2–4× slower per-core → **~2–4 minutes per province
extract**, ~500 MB–1 GB transient native RAM. Feasible as a fallback, but the
peak is a new risk on low-RAM devices and the data-tools build pulls in extra
dependencies (sqlite, spatialite). Prebuilding is strongly preferred.

---

## 4. Measurements: routing (the "pathing" step)

In-process `tyr::actor` (the pyvalhalla `Actor` — same call a JNI plugin or the
Rust crate would make), `auto` costing, warm = tiles already cached.

| Extract | Route | Cold | Warm | Peak RSS* |
|---|---|---|---|---|
| Bremen | 5 km in-city | 95 ms | 12 ms | 87 MB |
| Bremen | 28 km across city | 9 ms | 9 ms | 88 MB |
| Schleswig-Holstein | 7.7 km in-city | 86 ms | 9 ms | 80 MB |
| Schleswig-Holstein | 164 km cross-province | 78 ms | 37 ms | 129 MB |
| Alberta | 17 km in-city | 162 ms | 35 ms | 147 MB |
| Alberta | 300 km Calgary–Edmonton | 146 ms | 88 ms | 224 MB |
| Alberta | **739 km** end-to-end | **53 ms** | 49 ms | 228 MB |

\* ru_maxrss of the whole process, including a ~58 MB Python interpreter
baseline. Engine-attributable memory is roughly the column minus 58 MB.

Bare native (`valhalla_service` one-shot: process start → route JSON,
including tile load):

| Route | Wall | Peak RSS |
|---|---|---|
| SH, 164 km | 0.17 s | 115 MB |
| Alberta, 300 km | 0.35 s | 210 MB |

Published WASM figures *(tobilg/valhalla-wasm, Apple M2, Liechtenstein
corpus)*: warm route **15–22 ms**, cold route ~380 ms (includes loopback tile
fetches; 5 tiles / 1.48 MB per cold route), worker+module startup ~90–100 ms,
WASM linear memory floor **64 MiB** with 16,384-label reservations (their
earlier 2M-label defaults caused a **166 MiB** floor), 512 MiB default cap.
`ecc521/valhalla-wasm` reports **~20–50 MB** working set per route over a
multi-hundred-MB graph *(published)*.

### 4.1 The WASM engine, benchmarked (this study)

The question "WASM or native?" was put to a direct benchmark. The engine was
`ecc521/valhalla-wasm`'s prebuilt `valhalla.js`/`valhalla.wasm` (Valhalla
`f7764b3`, Emscripten 6.0.0) driving **the same 3.9.1-built tiles** used in
§3/§4 — tile compatibility across the pins verified by matching route answers
to the decimal (e.g. Alberta 739 km: 423.4 min in both). Two hosts: Node 26
(fs-backed tile source) and **real Chromium** (Playwright, package worker +
OPFS `SyncAccessHandle` — the exact integration shape rivers.run ships for
Capacitor). Same requests as §4; "warm" = tiles cached.

| Route | Native warm (§4) | WASM Node warm | WASM Chromium warm | WASM Chromium cold* |
|---|---|---|---|---|
| Bremen 5 km / 28 km | 9–12 ms | 13–14 ms | – | – |
| SH 7.7 km | 9 ms | 10–11 ms | 11–12 ms | 618 ms |
| SH 164 km | 37 ms | 58–61 ms | 58–68 ms | 206 ms |
| Alberta 17 km | 35 ms | 51 ms | 55 ms | 1172 ms\*\* |
| Alberta 300 km | 88 ms | 122–129 ms | 129–139 ms | 343 ms |
| Alberta 739 km | 49–53 ms | 73–75 ms | 79–86 ms | 114 ms |

\* first route over a not-yet-read corridor (tile loads + search).
\*\* first route in a fresh worker — includes WASM compile + module init
(≈0.5–1 s). Eagerly starting the worker at app launch removes it from the
driver-visible path.

- **WASM costs ~1.4–1.7× native** warm, on every extract size and route
  length. Not the feared 2–3×. On a phone core (×2–4 slower), the worst warm
  case (300 km) lands around 0.25–0.5 s and a reroute-scale route around
  0.1–0.25 s — comfortably interactive.
- **A real pathology was found and fixed.** With the package's default tile
  source (one sync OPFS read per `read()` call), the cold SH 164 km route took
  **5,346 ms** — Valhalla reads tiles in many small chunks and each chunk paid
  an OPFS hop. A ~30-line tile-source wrapper that loads each tile in one read
  on first touch cut it to **206 ms** (25×). This is an app-layer fix inside
  the `TileSource` seam; any Capacitor Filesystem source should carry the same
  whole-tile cache.
- **Memory:** Node RSS over the ~60 MB interpreter baseline reached ~140 MB
  (Bremen), ~250 MB (SH), ~350 MB (Alberta) with the package's default 200 MB
  Valhalla LRU cache — the cache cap is a config knob and can be lowered
  (their published working set is ~20–50 MB/route). The WASM heap itself is
  bounded by `ALLOW_MEMORY_GROWTH` to a configured ceiling; tobilg's measured
  floor on small corpora is 64 MiB with 16k-label reservations.
- Tar sizes equal the tile dirs (plain tar + 512-byte headers): 23.9 / 168.8 /
  279.9 MB for Bremen / SH / Alberta — the pack file `regions/download.ts`
  would cache is the same byte cost as measured in §3.

CPU conclusions:

- A **739 km route plans in ~50 ms** on one x86 core. The hierarchy +
  bidirectional A* means query cost grows with corridor, not with extract
  size. The current flat A* has a **1,200,000-expansion cap**
  (`engine.worker.ts:1067`) and no hierarchy; on a province extract,
  long routes would hit the cap, while Valhalla answers them instantly.
- Extrapolating ×2–4 for a phone core: worst observed case (300 km, warm,
  88 ms) lands around **0.2–0.4 s**; in-city reroutes in the **tens of ms**.
  That is an interactive reroute with room to spare — versus the 20 s network
  timeout the hosted path allows (`valhalla.ts:27`).
- WASM is ~2–3× slower than native (Asyncify) *(published)* — still tens of
  ms warm. Reroute frequency is event-driven (off-route), not per-tick, so
  even the cold ~400 ms path is acceptable.

Memory conclusions:

- Runtime engine memory is **bounded and small**: ~30–170 MB over baseline
  even for a 739 km route across a 279 MB tile set, because only corridor
  tiles are touched. Under WASM the ceiling is *configured*
  (64–512 MiB) — the app can state a hard bound and keep it.
- Contrast with today's model, where the whole graph is resident: 96 B/node +
  24 B/edge in the JS heap, a 229 B/kept-node parse peak
  (`importguard.ts:113`), a 7.5× merge peak (`mergeguard.ts:83–90`), and a
  guard that **refuses provinces outright**. Valhalla replaces all of that
  with "tiles on disk + a tile cache with a byte budget".
- The current guards (`importguard`, `mergeguard`) would shrink to a
  disk-space check and a cache-budget check — simpler, and honest by
  construction.

Disk conclusions:

- Tiles ≈ the size of the compressed extract the app already downloads.
  Per region pack, tens of MB (city) to ~280 MB (province). The indexed tar
  form is one file — a drop-in for the existing Capacitor Filesystem cache in
  `src/regions/download.ts`.
- App size cost: 7.4–10 MB (WASM) or a few MB per ABI (native .so).

---

## 5. What this fixes in the current design

| Current gap | With local Valhalla |
|---|---|
| Gap 6: inferred turn-by-turn misses 3/7 maneuvers | Real maneuvers, instructions, signs, verbal prompts from odin. `localToRoute`'s empty `maneuvers` (`providers.ts:158–184`) disappears; the `ValhallaGuidance` path in `App.tsx` works offline. `hasManeuvers()` (`engines.ts:238`) stops meaning "is it online" |
| Gap 13: province extracts refused (Alberta) | 44.5 s / 2.4 GB build, or zero if prebuilt. The 13 GB estimate was for the JS graph model, not for tiles |
| §3.18 cross-region routing: merge is a 7.5× memory blowup guarded by `mergeguard`, previously produced plausible-but-wrong stitched routes | Regions are just tile sets from one release (§6). A cross-region route is one search over adjacent tiles — no merge step at all |
| Reroute latency bounded by 20 s network timeout | Sub-second local compute |
| Long routes: hosted Valhalla refuses >1500 km with a translated error | Still 1500 km (Valhalla's own cap) but computed locally; the current offline A* would fail much sooner via its expansion cap |
| Engine fallback policy, `VALHALLA_ERRORS` table, trace rows | Unchanged — a local Valhalla returns the same JSON the client already parses (`src/nav/valhalla.ts`) |

**What it does not fix:** offline *search*. Valhalla tiles carry routing
attributes, not a gazetteer. `src/nav/geocode.ts`'s city/street/address/POI
search still needs OSM tags — so either the PBF import path stays (as a
tag-only, much lighter pass), or the tile pipeline also ships a search index.
This is the one part of `engine.worker.ts` that survives either way.

---

## 6. The tile supply chain (the main design decision)

Tiles must be **built**, and that is where the real architecture question lives:

1. **Prebuilt packs (recommended).** Partition one planet/continental build
   into per-region tar packs. Because all packs come from one build, shared
   border tiles are *bit-identical* across packs, so cross-region routing works
   the moment two packs are installed. This is how Nextzen's old metro
   extracts and tobilg's manifest model work. Cost: a CI/server job
   (planet ≈ 15 h once, then incremental) and hosting ~280 MB per province
   pack. `regions/download.ts` swaps `.osm.pbf` for the pack.
2. **On-device build from the downloaded PBF.** No new infrastructure; the
   app downloads exactly what it downloads today. Cost: minutes of CPU and
   ~0.5–2.4 GB transient native RAM per province (§3), and the data-tools
   dependency set if done natively. **Mixing separately-built packs is not
   safe** — two independent builds assign different internal ids to the same
   border tiles, and cross-tile references then dangle. The current union-find
   merge (`src/osm/merge.ts`) has no analogue here; the equivalent is "build
   from the union of the extracts", which is exactly what
   `valhalla_build_tiles a.osm.pbf b.osm.pbf` does natively.
3. **Hybrid.** Prebuilt packs as the norm; on-device rebuild as the documented
   fallback when a pack is missing.

---

## 7. Risks and open questions

- **Mobile WebView is unverified, but only the *device* remains unknown.** The
  WASM engine + our tiles are now verified in real Chromium in a worker over
  OPFS (§4.1) — the same engine family as Android WebView. The remaining
  question is phone CPU/RAM and WebView OPFS/Filesystem behaviour, which is
  exactly what recommendation 1 measures.
- **Tile reads must be whole-tile cached.** Measured: per-chunk OPFS reads made
  a cold 164 km route take 5.3 s; a whole-tile cache in the `TileSource` cut it
  to 206 ms (§4.1). This is the single most important integration detail.
- **WASM memory ceilings vs old WebViews.** 64–512 MiB of WASM linear memory
  must fit alongside MapLibre GL. Start with 128 MiB cap and the 16k-label
  reservation policy (tobilg's measured floor is 64 MiB).
- **Phone RAM during any on-device build** is the one number this study could
  not measure. It is only spent in supply-chain option 2.
- **Licensing/attribution:** Valhalla is MIT; OSM data is ODbL — the existing
  attribution requirement (already honoured for the basemap) extends to tile
  packs.
- **Versions:** measurements are on 3.9.1; tobilg pins 3.8.3. Both are current
  3.x; the actor API and tile format are stable across them.

---

## 8. Verdict and recommendation

**Feasible, and resource-positive.** Local Valhalla uses *less* memory at
runtime than the current engine (bounded tile cache vs a fully resident CSR
graph), *comparable* disk (tiles ≈ the extract already downloaded), and *more
CPU per query in absolute terms but far better scaling* (a 739 km route in
~50 ms vs an expansion-capped flat A*) — while closing the app's worst
quality gap (real turn-by-turn) and deleting the merge-guard complexity.

**WASM or native? WASM** — and now measured, not guessed (§4.1). The WASM
engine is only ~1.4–1.7× slower than native on every case we threw at it, up
to a 739 km route across a 279 MB tile set in a real Chromium worker. That
margin does not justify the native route's costs: the NDK toolchain and its
boost/protobuf cross-builds (days, per §5.3's honest estimate), a per-ABI
`.so`, a JNI bridge, and a second engine build that the browser test suite
cannot exercise. WASM runs the *same bytes* in the browser build and the
Android WebView, is testable in the Chromium suite the repo already runs, and
its memory is a configured hard ceiling. Native remains the fallback if — and
only if — the phone WebView shows a problem the desktop run did not (see
risks), and the §4 native numbers are the baseline it would be judged against.

Recommended path, in order:

1. **Spike (days, now mostly de-risked):** wire `ecc521/valhalla-wasm`'s
   worker + a Bremen pack into the existing worker pipeline in the Android
   WebView; measure the §4.1 rows on a real phone. The engine, the tiles, and
   the browser behaviour are already verified; the phone is the last unknown.
2. **Integration shape:** `local` = WASM Valhalla in a Web Worker with a
   Capacitor-Filesystem `TileSource` carrying the **whole-tile read cache**
   (§4.1 — without it, cold long routes are an order of magnitude slower).
   Keep the hosted `valhalla-*` providers and the whole engine/fallback/trace
   machinery (`engines.ts`, `providers.ts`) untouched — it already speaks this
   protocol. Start the worker at app launch so the ~1 s WASM compile is never
   on the driver's clock. Keep `geocode.ts` and a slimmed tag pass for search.
3. **Supply chain:** one continental build partitioned into region packs
   (option 6.1), served to `regions/download.ts`. Cross-region routing becomes
   correct-by-construction and `merge.ts`/`mergeguard.ts` retire.
4. **Only if the phone WebView fails:** the NDK library route (§1 B) — its
   dependency set is boost headers + protobuf + zlib for a
   `-DENABLE_SERVICES=OFF -DENABLE_TOOLS=OFF -DENABLE_DATA_TOOLS=OFF` build;
   STATUS §5.3's list (luajit, GEOS, prime_server, sqlite3) belongs to the
   service/data-tools build and does not apply. vcpkg or the Rust crate's
   build script are the known recipes. It buys the last ~1.5× of latency and
   nothing else.
5. **Retire, don't delete, the TypeScript engine** until the WASM path has
   replaced every tested route; `test/astar-admissible.spec.ts` and friends
   remain the regression net for whatever period both engines coexist.

*Method note: every number here is reproducible with the upstream
`pyvalhalla` 3.9.1 binaries and Geofabrik extracts; the harness used is in
`/tmp/opencode/valhalla/` (`bench_route.py`, `config-*.json`, build logs) and
`/tmp/opencode/valhalla/wasm-bench/` (`bench_wasm.mjs` for Node,
`bench_browser.html`/`bench_worker.js`/`run_browser.cjs` for the Chromium
runs). Published figures are attributed inline.*
